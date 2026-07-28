"""
ZTCE WebSocket Consumers
━━━━━━━━━━━━━━━━━━━━━━━━
Asynchronous ASGI WebSocket consumers for the real-time sync engine.

SessionConsumer — broadcasts session-level events (activity, files, whiteboard)
OperatorConsumer — handles per-operator code sync, messaging, and file changes

All communication happens over the local network via Django Channels.
Zero external routing — fully functional in air-gapped environments.
"""

from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
import json
import logging
from django.utils import timezone

from .models import OperatorFile

logger = logging.getLogger(__name__)


class SessionConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer for session-wide real-time broadcasts.
    Handles: activity updates, file broadcasts, whiteboard sync,
    PDF annotation sync, task updates, and live code streaming.
    """

    async def connect(self):
        self.session_id = self.scope['url_route']['kwargs']['session_id']
        self.session_group_name = f'session_{self.session_id}'

        await self.channel_layer.group_add(
            self.session_group_name,
            self.channel_name
        )
        await self.accept()
        logger.info(f"Operator connected to session {self.session_id}")

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(
            self.session_group_name,
            self.channel_name
        )
        logger.info(f"Operator disconnected from session {self.session_id}")

    async def receive(self, text_data):
        """Route incoming WebSocket messages to appropriate group broadcasts."""
        try:
            data = json.loads(text_data)
            message_type = data.get('type')

            if message_type == 'activity_update':
                await self.channel_layer.group_send(
                    self.session_group_name,
                    {
                        'type': 'activity_update',
                        'operator_id': data.get('operator_id'),
                        'status': data.get('status'),
                    }
                )
            elif message_type == 'file_broadcast':
                await self.channel_layer.group_send(
                    self.session_group_name,
                    {
                        'type': 'file_broadcast',
                        'file_id': data.get('file_id'),
                        'filename': data.get('filename'),
                    }
                )
            elif message_type == 'whiteboard_update':
                await self.channel_layer.group_send(
                    self.session_group_name,
                    {
                        'type': 'whiteboard_update',
                        'elements': data.get('elements'),
                        'appState': data.get('appState'),
                    }
                )
            elif message_type == 'pdf_whiteboard_update':
                await self.channel_layer.group_send(
                    self.session_group_name,
                    {
                        'type': 'pdf_whiteboard_update',
                        'file_id': data.get('file_id'),
                        'page': data.get('page'),
                        'elements': data.get('elements'),
                        'appState': data.get('appState'),
                    }
                )
            elif message_type == 'pdf_page_change':
                await self.channel_layer.group_send(
                    self.session_group_name,
                    {
                        'type': 'pdf_page_change',
                        'file_id': data.get('file_id'),
                        'page': data.get('page'),
                    }
                )
        except json.JSONDecodeError:
            logger.error("Invalid JSON received on session WebSocket")

    # ─── Event Handlers ──────────────────────────────────────────────────────

    async def activity_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'activity_update',
            'operator_id': event['operator_id'],
            'status': event['status'],
        }))

    async def file_broadcast(self, event):
        await self.send(text_data=json.dumps({
            'type': 'file_broadcast',
            'file_id': event['file_id'],
            'filename': event['filename'],
        }))

    async def operator_added(self, event):
        await self.send(text_data=json.dumps({
            'type': 'operator_added',
            'operator_id': event['operator_id'],
            'operator_name': event['operator_name'],
        }))

    async def ai_status_changed(self, event):
        await self.send(text_data=json.dumps({
            'type': 'ai_status_changed',
            'ai_enabled': event['ai_enabled'],
        }))

    async def task_updated(self, event):
        await self.send(text_data=json.dumps({
            'type': 'task_updated',
            'event': event.get('event', 'updated'),
            'task': event.get('task', {}),
        }))

    async def admin_code_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'admin_code_update',
            'code': event.get('code', ''),
        }))

    async def whiteboard_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'whiteboard_update',
            'elements': event.get('elements'),
            'appState': event.get('appState'),
        }))

    async def pdf_whiteboard_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'pdf_whiteboard_update',
            'file_id': event.get('file_id'),
            'page': event.get('page'),
            'elements': event.get('elements'),
            'appState': event.get('appState'),
        }))

    async def pdf_page_change(self, event):
        await self.send(text_data=json.dumps({
            'type': 'pdf_page_change',
            'file_id': event.get('file_id'),
            'page': event.get('page'),
        }))


class OperatorConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer for per-operator real-time code synchronization.
    Handles: code updates with version tracking, chat messages,
    broadcast file notifications, and live code streaming.
    """

    async def connect(self):
        self.operator_id = self.scope['url_route']['kwargs']['operator_id']
        self.operator_group_name = f'operator_{self.operator_id}'

        await self.channel_layer.group_add(
            self.operator_group_name,
            self.channel_name
        )
        await self.accept()
        logger.info(f"Operator {self.operator_id} connected")

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(
            self.operator_group_name,
            self.channel_name
        )
        logger.info(f"Operator {self.operator_id} disconnected")

    async def receive(self, text_data):
        """Handle incoming code updates and messages with persistence."""
        try:
            data = json.loads(text_data)
            message_type = data.get('type')

            if message_type == 'code_update':
                filename = data.get('filename')
                content = data.get('content', '')
                source_client_id = data.get('client_id')

                if not filename:
                    return

                # Persist code change to database
                version = await self._persist_code_update(filename, content)

                # Broadcast to all connected clients for this operator
                await self.channel_layer.group_send(
                    self.operator_group_name,
                    {
                        'type': 'code_update',
                        'filename': filename,
                        'content': content,
                        'version': version,
                        'source_client_id': source_client_id,
                        'updated_at': timezone.now().isoformat(),
                    }
                )
            elif message_type == 'message':
                await self.channel_layer.group_send(
                    self.operator_group_name,
                    {
                        'type': 'new_message',
                        'sender': data.get('sender'),
                        'content': data.get('content'),
                    }
                )
        except json.JSONDecodeError:
            logger.error("Invalid JSON received on operator WebSocket")

    @database_sync_to_async
    def _persist_code_update(self, filename, content):
        """Persist code changes to the database with automatic version bumping."""
        file = OperatorFile.objects.filter(
            operator_id=self.operator_id,
            filename=filename,
        ).first()
        if not file:
            return None
        file.content = content
        file.increment_version()
        return file.version

    # ─── Event Handlers ──────────────────────────────────────────────────────

    async def code_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'code_update',
            'filename': event['filename'],
            'content': event['content'],
            'version': event.get('version'),
            'source_client_id': event.get('source_client_id'),
            'updated_at': event.get('updated_at'),
        }))

    async def new_message(self, event):
        await self.send(text_data=json.dumps({
            'type': 'new_message',
            'sender': event['sender'],
            'content': event['content'],
        }))

    async def broadcast_file_changed(self, event):
        await self.send(text_data=json.dumps({
            'type': 'broadcast_file_changed',
            'file_id': event.get('file_id'),
            'filename': event.get('filename'),
            'file_type': event.get('file_type'),
        }))

    async def admin_code_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'admin_code_update',
            'code': event.get('code'),
        }))

    async def file_broadcast(self, event):
        await self.send(text_data=json.dumps({
            'type': 'file_broadcast',
            'file_id': event.get('file_id'),
            'filename': event.get('filename'),
        }))
