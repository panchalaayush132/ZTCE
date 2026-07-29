import json
import subprocess
import importlib
import pkgutil
import time
import os
import sys
import socket
import ipaddress
import urllib.error
import urllib.request
from functools import lru_cache
from pathlib import Path
from datetime import datetime, timedelta

from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.conf import settings
from django.http import JsonResponse
from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from .models import (
    Session, Operator, OperatorFile, ActivityLog, CodeSnapshot,
    Message, BroadcastFile, CodeExecution, AISuggestion, SessionTask,
    Test, TestSubmission
)
from .serializers import (
    SessionSerializer, OperatorSerializer, OperatorFileSerializer,
    ActivityLogSerializer, CodeSnapshotSerializer, MessageSerializer,
    BroadcastFileSerializer, CodeExecutionSerializer, AISuggestionSerializer,
    SessionTaskSerializer, TestSerializer, TestSubmissionSerializer
)
from .security_utils import decrypt_text, encrypt_text, enforce_session_token, throttle_request

try:
    import google.generativeai as genai
    GEMINI_API_KEY = settings.GEMINI_API_KEY
    if GEMINI_API_KEY:
        genai.configure(api_key=GEMINI_API_KEY)
        GEMINI_AVAILABLE = True
    else:
        GEMINI_AVAILABLE = False
except Exception:
    GEMINI_AVAILABLE = False

OLLAMA_BASE_URL = getattr(settings, 'OLLAMA_BASE_URL', '').rstrip('/')


def _generate_with_ollama(model_name: str, prompt_text: str) -> str:
    if not OLLAMA_BASE_URL:
        raise RuntimeError('OLLAMA_BASE_URL is not configured')

    payload = json.dumps({
        'model': model_name,
        'prompt': prompt_text,
        'stream': False,
    }).encode('utf-8')

    request = urllib.request.Request(
        f'{OLLAMA_BASE_URL}/api/generate',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )

    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            response_data = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        body = ''
        try:
            body = exc.read().decode('utf-8', errors='ignore')
        except Exception:
            body = ''

        if exc.code == 404:
            raise RuntimeError(
                f"Ollama model '{model_name}' not found. Install it with: ollama pull {model_name}"
            ) from exc

        raise RuntimeError(f'Ollama request failed: HTTP {exc.code} {exc.reason}. {body}'.strip()) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f'Ollama request failed: {exc}') from exc

    return response_data.get('response', '').strip()


# ==================== AUTOCOMPLETE ENGINE ====================

PROJECT_ROOT = Path(settings.BASE_DIR)
IGNORED_DIRS = {'env', '.git', '__pycache__', 'node_modules', 'staticfiles', 'media', '.idea', '.vscode', 'dist', 'build'}
IGNORED_FILES = {'db.sqlite3', '.env'}
operator_runtimes_ROOT = PROJECT_ROOT / 'operator_runtimes'


def _resolve_session_for_join(session_identifier):
    """Resolve a session by UUID id first, then by session token."""
    if not session_identifier:
        return None

    # Try as UUID first
    try:
        session = Session.objects.filter(id=session_identifier).first()
        if session:
            return session
    except (ValueError, TypeError):
        # Not a valid UUID, continue to token lookup
        pass

    # Try as token
    return Session.objects.filter(session_token=session_identifier).first()


def _operator_runtime_paths(operator_id: str):
    runtime_root = operator_runtimes_ROOT / str(operator_id)
    venv_dir = runtime_root / '.venv'
    workspace_dir = runtime_root / 'workspace'
    python_executable = venv_dir / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    scripts_dir = venv_dir / ('Scripts' if os.name == 'nt' else 'bin')
    return runtime_root, venv_dir, workspace_dir, python_executable, scripts_dir


def _ensure_operator_runtime(operator_id: str):
    runtime_root, venv_dir, workspace_dir, python_executable, scripts_dir = _operator_runtime_paths(operator_id)

    runtime_root.mkdir(parents=True, exist_ok=True)
    workspace_dir.mkdir(parents=True, exist_ok=True)

    if not python_executable.exists():
        subprocess.run(
            [sys.executable, '-m', 'venv', str(venv_dir)],
            check=True,
            timeout=120,
        )

    env = os.environ.copy()
    env['VIRTUAL_ENV'] = str(venv_dir)
    env['PATH'] = str(scripts_dir) + os.pathsep + env.get('PATH', '')
    env['PYTHONNOUSERSITE'] = '1'
    env.pop('PYTHONPATH', None)

    return {
        'runtime_root': runtime_root,
        'venv_dir': venv_dir,
        'workspace_dir': workspace_dir,
        'python_executable': python_executable,
        'env': env,
    }


def _detect_lan_ip():
    """Best-effort detection of the machine's LAN IPv4 address."""
    candidates = []

    def _add_candidate(value):
        try:
            ip = ipaddress.ip_address((value or '').strip())
        except ValueError:
            return

        if ip.version != 4 or ip.is_loopback or ip.is_unspecified:
            return

        ip_text = str(ip)
        if ip_text not in candidates:
            candidates.append(ip_text)

    try:
        hostname = socket.gethostname()
        host_info = socket.gethostbyname_ex(hostname)
        for candidate in host_info[2]:
            _add_candidate(candidate)
    except OSError:
        pass

    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            _add_candidate(info[4][0])
    except OSError:
        pass

    probe = None
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.settimeout(0.2)
        probe.connect(('8.8.8.8', 80))
        _add_candidate(probe.getsockname()[0])
    except OSError:
        pass
    finally:
        if probe is not None:
            try:
                probe.close()
            except OSError:
                pass

    probe = None
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(('10.255.255.255', 1))
        _add_candidate(probe.getsockname()[0])
    except OSError:
        pass
    finally:
        if probe is not None:
            try:
                probe.close()
            except OSError:
                pass

    for candidate in candidates:
        try:
            if ipaddress.ip_address(candidate).is_private:
                return candidate
        except ValueError:
            continue

    if candidates:
        return candidates[0]

    return '127.0.0.1'


def _sync_operator_workspace(operator_id: str, workspace_dir: Path):
    """Mirror Operator files into persistent workspace for accurate execution context."""
    files = OperatorFile.objects.filter(operator_id=operator_id)
    for operator_file in files:
        relative_path = operator_file.filename.strip().replace('\\', '/')
        if not relative_path:
            continue

        destination = workspace_dir / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(operator_file.content or '', encoding='utf-8')


def _coerce_bool(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {'1', 'true', 'yes', 'on'}


def _build_tree(path: Path, max_depth: int = 5, current_depth: int = 0):
    """Recursively build project tree for autocomplete"""
    if current_depth >= max_depth or not path.exists() or not path.is_dir():
        return []

    nodes = []
    try:
        entries = sorted(path.iterdir(), key=lambda item: (item.is_file(), item.name.lower()))
    except OSError:
        return []

    for entry in entries:
        if entry.name in IGNORED_DIRS and entry.is_dir():
            continue
        if entry.name in IGNORED_FILES:
            continue

        relative_path = entry.relative_to(PROJECT_ROOT).as_posix()
        node = {
            'name': entry.name,
            'path': relative_path,
            'type': 'directory' if entry.is_dir() else 'file',
        }

        if entry.is_dir():
            children = _build_tree(entry, max_depth=max_depth, current_depth=current_depth + 1)
            if children:
                node['children'] = children

        nodes.append(node)

    return nodes


def _flatten_tree(nodes):
    """Flatten tree structure for path list"""
    flattened = []
    for node in nodes:
        flattened.append(node['path'])
        for child in node.get('children', []):
            flattened.extend(_flatten_tree([child]))
    return flattened


@lru_cache(maxsize=1)
def _autocomplete_catalog():
    """Get cached autocomplete context"""
    installed_modules = sorted({m.name for m in pkgutil.iter_modules() if not m.name.startswith('_')})
    
    django_terms = [
        'django', 'models', 'views', 'urls', 'forms', 'admin', 'serializers',
        'path', 'include', 'render', 'redirect', 'JsonResponse', 'HttpResponse',
        'ForeignKey', 'ManyToManyField', 'OneToOneField', 'Model', 'ViewSet',
    ]
    
    python_keywords = [
        'def', 'class', 'import', 'from', 'for', 'while', 'if', 'elif', 'else',
        'try', 'except', 'finally', 'with', 'as', 'lambda', 'return', 'yield',
        'async', 'await', 'print', 'len', 'range', 'open', 'str', 'int', 'float',
        'list', 'dict', 'set', 'tuple', 'enumerate', 'zip', 'map', 'filter',
        'sorted', 'sum', 'min', 'max', 'super', 'self', 'True', 'False', 'None',
    ]
    
    project_tree = _build_tree(PROJECT_ROOT)
    project_paths = _flatten_tree(project_tree)
    project_names = sorted({Path(p).name for p in project_paths if Path(p).name})

    return {
        'python_keywords': python_keywords,
        'installed_modules': installed_modules[:500],
        'django_terms': django_terms,
        'project_tree': project_tree,
        'project_paths': project_paths,
        'project_names': project_names,
    }


@lru_cache(maxsize=128)
def _module_attributes(module_name: str):
    """Get cached module attributes for dot-completion"""
    try:
        module = importlib.import_module(module_name)
    except Exception:
        return []

    attributes = [name for name in dir(module) if not name.startswith('_')]
    return sorted(attributes)


# ==================== API VIEWSETS ====================

class SessionViewSet(viewsets.ModelViewSet):
    """Session management - Create, list, retrieve, update sessions"""
    queryset = Session.objects.all()
    serializer_class = SessionSerializer

    def _build_analytics_payload(self, session):
        cutoff = timezone.now() - timedelta(days=7)
        leaderboard = []

        for operator_obj in session.operators.all():
            executions = operator_obj.executions.all()
            total_execs = executions.count()
            success_execs = executions.filter(return_code=0, stderr='').count()
            accuracy = (success_execs / total_execs * 100) if total_execs > 0 else 0

            recent_activity = operator_obj.activity_logs.filter(created_at__gte=cutoff)
            green_logs = recent_activity.filter(status='green').count()
            yellow_logs = recent_activity.filter(status='yellow').count()
            red_logs = recent_activity.filter(status='red').count()
            idle_logs = recent_activity.filter(status='idle').count()
            behavior_score = int((accuracy * 0.7) + (green_logs * 2) + (yellow_logs * 0.6) - (red_logs * 1.5) - (idle_logs * 0.2))

            leaderboard.append({
                'operator_id': operator_obj.id,
                'name': operator_obj.name,
                'username': operator_obj.username,
                'accuracy': round(accuracy, 1),
                'total_executions': total_execs,
                'weekly_activity': {
                    'green': green_logs,
                    'yellow': yellow_logs,
                    'red': red_logs,
                    'idle': idle_logs,
                },
                'score': behavior_score,
            })

        leaderboard.sort(key=lambda item: item['score'], reverse=True)
        weekly_activity_total = ActivityLog.objects.filter(operator__session=session, created_at__gte=cutoff).count()

        return {
            'session_id': str(session.id),
            'leaderboard_visible': session.leaderboard_visible,
            'total_operators': session.operators.count(),
            'weekly_activity_total': weekly_activity_total,
            'top_10': leaderboard[:10],
        }
    
    @action(detail=False, methods=['post'])
    def create_session(self, request):
        """Create a new tutoring session"""
        creator_id = request.data.get('creator_id', 'admin')
        creator_name = request.data.get('creator_name', 'Admin')
        description = request.data.get('description', '')
        leaderboard_visible = _coerce_bool(request.data.get('leaderboard_visible', False))
        
        session = Session.objects.create(
            creator_id=creator_id,
            creator_name=creator_name,
            description=description,
            leaderboard_visible=leaderboard_visible,
        )
        return Response(SessionSerializer(session).data, status=status.HTTP_201_CREATED)
    
    @action(detail=True, methods=['post'])
    def end_session(self, request, pk=None):
        """End a session"""
        session = self.get_object()
        enforce_session_token(request, session)
        session.is_active = False
        session.save()
        return Response({'success': True, 'message': 'Session ended'})

    def _set_session_flag(self, request, field_name: str):
        session = self.get_object()
        enforce_session_token(request, session)
        if field_name not in {'ai_enabled', 'autocomplete_enabled', 'leaderboard_visible', 'allow_operator_download'}:
            return Response({'error': 'Unsupported feature'}, status=status.HTTP_400_BAD_REQUEST)

        if 'enabled' in request.data:
            next_state = _coerce_bool(request.data.get('enabled'))
        else:
            next_state = not getattr(session, field_name)

        setattr(session, field_name, next_state)
        session.save(update_fields=[field_name])
        return Response(SessionSerializer(session).data)

    @action(detail=True, methods=['post'])
    def toggle_ai(self, request, pk=None):
        return self._set_session_flag(request, 'ai_enabled')

    @action(detail=True, methods=['post'])
    def toggle_autocomplete(self, request, pk=None):
        return self._set_session_flag(request, 'autocomplete_enabled')

    @action(detail=True, methods=['post'])
    def toggle_leaderboard_visibility(self, request, pk=None):
        return self._set_session_flag(request, 'leaderboard_visible')

    @action(detail=True, methods=['post'])
    def toggle_download(self, request, pk=None):
        return self._set_session_flag(request, 'allow_operator_download')

    @action(detail=True, methods=['post'])
    def update_tutor_code(self, request, pk=None):
        """Broadcast live tutor code to all operators"""
        session = self.get_object()
        enforce_session_token(request, session)
        code = request.data.get('code', '')
        
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f'session_{session.id}',
            {
                'type': 'admin_code_update',
                'code': code,
            }
        )
        return Response({'status': 'success'})

    @action(detail=True, methods=['post'])
    def export_workspaces(self, request, pk=None):
        """Export all Operator files to local host filesystem"""
        session = self.get_object()
        enforce_session_token(request, session)
        
        from django.conf import settings
        import os
        
        export_root = os.path.join(settings.BASE_DIR, 'operator_workspaces', str(session.id)[:8])
        os.makedirs(export_root, exist_ok=True)
        
        exported_count = 0
        for operator_obj in session.operators.all():
            operator_dir = os.path.join(export_root, operator_obj.name)
            os.makedirs(operator_dir, exist_ok=True)
            for s_file in operator_obj.files.all():
                safe_filename = os.path.normpath(s_file.filename).replace('\\', '/')
                if safe_filename.startswith('..') or safe_filename.startswith('/'):
                    continue
                file_path = os.path.join(operator_dir, safe_filename)
                
                # Verify resolved path stays within operator_dir
                resolved_path = os.path.realpath(file_path)
                if not resolved_path.startswith(os.path.realpath(operator_dir)):
                    continue
                
                with open(file_path, 'w', encoding='utf-8') as f:
                    f.write(s_file.content)
                exported_count += 1
                
        return Response({
            'success': True, 
            'message': f'Exported {exported_count} files to {export_root}'
        })

    @action(detail=True, methods=['get'])
    def analytics_report(self, request, pk=None):
        """Generate analytics report and top 10 leaderboard for the session"""
        session = self.get_object()
        enforce_session_token(request, session)
        return Response(self._build_analytics_payload(session))

    @action(detail=True, methods=['get'])
    def public_analytics_report(self, request, pk=None):
        """Provide leaderboard data to Operators when the tutor enables it."""
        session = self.get_object()
        if not session.leaderboard_visible:
            return Response({'error': 'Leaderboard disabled for this session'}, status=status.HTTP_403_FORBIDDEN)
        return Response(self._build_analytics_payload(session))

    @action(detail=False, methods=['post'])
    def add_operator(self, request):
        """Add Operator to a session"""
        session_id = request.data.get('session_id')
        username = request.data.get('username')
        name = request.data.get('name', username)
        email = request.data.get('email', '')
        
        if not session_id or not username:
            return Response({'error': 'session_id and username required'}, status=status.HTTP_400_BAD_REQUEST)

        session = _resolve_session_for_join(session_id)
        if not session:
            return Response({'error': 'Session not found. Check Session ID/token.'}, status=status.HTTP_404_NOT_FOUND)
        
        operator_obj, created = Operator.objects.get_or_create(
            session=session,
            username=username,
            defaults={'name': name, 'email': email}
        )
        
        # Create main file
        OperatorFile.objects.get_or_create(
            operator=operator_obj,
            filename='main.py',
            defaults={'is_main': True, 'content': '# Start coding here\n'}
        )

        # Notify tutor dashboards immediately when an operator joins/rejoins.
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f'session_{session.id}',
            {
                'type': 'operator_added',
                'operator_id': str(operator_obj.id),
                'operator_name': operator_obj.name,
            },
        )
        
        return Response(OperatorSerializer(operator_obj).data, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)
    
    @action(detail=True, methods=['post'])
    def heartbeat(self, request, pk=None):
        """Update Operator heartbeat (keep-alive)"""
        operator_obj = get_object_or_404(operator_obj, id=pk)
        operator_obj.last_heartbeat = timezone.now()
        operator_obj.save(update_fields=['last_heartbeat'])

        # Push online status updates to tutor dashboards in realtime.
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f'session_{operator_obj.session_id}',
            {
                'type': 'activity_update',
                'operator_id': str(operator_obj.id),
                'status': 'online',
            },
        )
        return Response({'is_online': operator_obj.is_online()})
    
    @action(detail=True, methods=['get'])
    def get_files(self, request, pk=None):
        """Get all files for an operator"""
        operator_obj = self.get_object()
        files = operator_obj.files.all()
        return Response(OperatorFileSerializer(files, many=True).data)


class OperatorViewSet(viewsets.ModelViewSet):
    """Operator management and realtime presence tracking."""
    queryset = Operator.objects.select_related('session').all()
    serializer_class = OperatorSerializer

    @action(detail=False, methods=['post'])
    def add_operator(self, request):
        """Add Operator to a session"""
        session_id = request.data.get('session_id')
        username = request.data.get('username')
        name = request.data.get('name', username)
        email = request.data.get('email', '')

        if not session_id or not username:
            return Response({'error': 'session_id and username required'}, status=status.HTTP_400_BAD_REQUEST)

        session = _resolve_session_for_join(session_id)
        if not session:
            return Response({'error': 'Session not found. Check Session ID/token.'}, status=status.HTTP_404_NOT_FOUND)

        operator_obj, created = Operator.objects.get_or_create(
            session=session,
            username=username,
            defaults={'name': name, 'email': email}
        )

        OperatorFile.objects.get_or_create(
            operator=operator_obj,
            filename='main.py',
            defaults={'is_main': True, 'content': '# Start coding here\n'}
        )

        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f'session_{session.id}',
            {
                'type': 'operator_added',
                'operator_id': str(operator_obj.id),
                'operator_name': operator_obj.name,
            },
        )

        return Response(OperatorSerializer(operator_obj).data, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)

    @action(detail=True, methods=['post'])
    def heartbeat(self, request, pk=None):
        """Update Operator heartbeat (keep-alive) and traffic light status"""
        operator_obj = self.get_object()
        operator_obj.last_heartbeat = timezone.now()
        operator_obj.save(update_fields=['last_heartbeat'])

        status_val = request.data.get('status', 'online')
        message = request.data.get('message', '')

        # Create ActivityLog if status is provided and different
        if status_val in ['green', 'yellow', 'red', 'idle']:
            last_log = ActivityLog.objects.filter(operator=operator_obj).first()
            if not last_log or last_log.status != status_val:
                ActivityLog.objects.create(operator=operator_obj, status=status_val, message=message)

        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f'session_{operator_obj.session_id}',
            {
                'type': 'activity_update',
                'operator_id': str(operator_obj.id),
                'status': status_val,
                'message': message,
            },
        )
        return Response({'is_online': operator_obj.is_online()})

    @action(detail=True, methods=['get'])
    def get_files(self, request, pk=None):
        """Get all files for an operator"""
        operator_obj = self.get_object()
        files = operator_obj.files.all()
        return Response(OperatorFileSerializer(files, many=True).data)

    @action(detail=True, methods=['post'])
    def leave_session(self, request, pk=None):
        """Mark the operator as leaving and persist their workspace immediately."""
        operator_obj = self.get_object()

        try:
            runtime = _ensure_operator_runtime(str(operator_obj.id))
            _sync_operator_workspace(str(operator_obj.id), runtime['workspace_dir'])
        except Exception:
            pass

        operator_obj.last_heartbeat = timezone.now() - timedelta(seconds=61)
        operator_obj.save(update_fields=['last_heartbeat'])

        ActivityLog.objects.create(
            operator=operator_obj,
            status='idle',
            message='Operator exited session',
        )

        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f'session_{operator_obj.session_id}',
            {
                'type': 'activity_update',
                'operator_id': str(operator_obj.id),
                'status': 'idle',
                'message': 'Operator exited session',
            },
        )

        return Response({'success': True, 'message': 'Session exited'})


class OperatorFileViewSet(viewsets.ModelViewSet):
    """Code file management - CRUD operations on Operator files"""
    queryset = OperatorFile.objects.all()
    serializer_class = OperatorFileSerializer
    
    @action(detail=False, methods=['post'])
    def create_file(self, request):
        """Create a new file for operator"""
        operator_id = request.data.get('operator_id')
        filename = request.data.get('filename', 'main.py')
        content = request.data.get('content', '# Start coding here\n')
        language = request.data.get('language', 'python')
        
        operator_obj = get_object_or_404(operator_obj, id=operator_id)
        
        file, created = OperatorFile.objects.get_or_create(
            operator=operator_obj,
            filename=filename,
            defaults={'content': content, 'language': language}
        )

        if not created:
            updated = False
            if content is not None and file.content != content:
                file.content = content
                updated = True
            if language and file.language != language:
                file.language = language
                updated = True
            if updated:
                file.increment_version()
                file.save()
        
        return Response(OperatorFileSerializer(file).data, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)
    
    @action(detail=True, methods=['patch', 'put'])
    def update_content(self, request, pk=None):
        """Update file content"""
        file = self.get_object()
        file.content = request.data.get('content', file.content)
        file.language = request.data.get('language', file.language)
        file.increment_version()
        file.save()

        source_client_id = request.data.get('client_id')
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f'operator_{file.operator_id}',
            {
                'type': 'code_update',
                'filename': file.filename,
                'content': file.content,
                'version': file.version,
                'source_client_id': source_client_id,
                'updated_at': timezone.now().isoformat(),
            }
        )
        return Response(OperatorFileSerializer(file).data)
    
    @action(detail=False, methods=['delete'])
    def delete_file(self, request):
        """Delete a file"""
        file_id = request.data.get('file_id')
        file = get_object_or_404(OperatorFile, id=file_id)
        file.delete()
        return Response({'detail': 'File deleted'})


class ActivityLogViewSet(viewsets.ModelViewSet):
    """Activity tracking - Log Operator status (green, yellow, red, idle)"""
    queryset = ActivityLog.objects.all()
    serializer_class = ActivityLogSerializer
    
    @action(detail=False, methods=['post'])
    def log_activity(self, request):
        """Log Operator activity"""
        operator_id = request.data.get('operator_id')
        status_val = request.data.get('status', 'idle')
        message = request.data.get('message', '')
        error_details = request.data.get('error_details', '')
        
        operator_obj = get_object_or_404(operator_obj, id=operator_id)
        
        log = ActivityLog.objects.create(
            operator=operator_obj,
            status=status_val,
            message=message,
            error_details=error_details
        )
        
        return Response(ActivityLogSerializer(log).data, status=status.HTTP_201_CREATED)
    
    @action(detail=False, methods=['get'])
    def get_operator_activity(self, request):
        """Get activity logs for an operator"""
        operator_id = request.query_params.get('operator_id')
        try:
            limit = int(request.query_params.get('limit', 50))
        except (TypeError, ValueError):
            limit = 50
        
        operator_obj = get_object_or_404(operator_obj, id=operator_id)
        logs = operator_obj.activity_logs.all()[:limit]
        
        return Response(ActivityLogSerializer(logs, many=True).data)


class CodeSnapshotViewSet(viewsets.ModelViewSet):
    """Code versioning - Save and retrieve code snapshots"""
    queryset = CodeSnapshot.objects.all()
    serializer_class = CodeSnapshotSerializer
    
    @action(detail=False, methods=['post'])
    def create_snapshot(self, request):
        """Create code snapshot"""
        operator_id = request.data.get('operator_id')
        filename = request.data.get('filename')
        content = request.data.get('content')
        message = request.data.get('message', '')
        language = request.data.get('language', 'python')
        
        operator_obj = get_object_or_404(operator_obj, id=operator_id)
        
        snapshot = CodeSnapshot.objects.create(
            operator=operator_obj,
            filename=filename,
            content=content,
            language=language,
            message=message
        )
        
        return Response(CodeSnapshotSerializer(snapshot).data, status=status.HTTP_201_CREATED)
    
    @action(detail=False, methods=['get'])
    def get_operator_snapshots(self, request):
        """Get snapshots for an operator"""
        operator_id = request.query_params.get('operator_id')
        try:
            limit = int(request.query_params.get('limit', 20))
        except (TypeError, ValueError):
            limit = 20
        
        operator_obj = get_object_or_404(operator_obj, id=operator_id)
        snapshots = operator_obj.snapshots.all()[:limit]
        
        return Response(CodeSnapshotSerializer(snapshots, many=True).data)


class MessageViewSet(viewsets.ModelViewSet):
    """Chat messages - Tutor-Operator communication"""
    queryset = Message.objects.all()
    serializer_class = MessageSerializer

    @action(detail=False, methods=['post'])
    def send_message(self, request):
        """Send a message"""
        operator_id = request.data.get('operator_id')
        sender = request.data.get('sender')
        content = request.data.get('content')

        operator_obj = get_object_or_404(operator_obj, id=operator_id)

        message = Message.objects.create(
            operator=operator_obj,
            sender=sender,
            content=encrypt_text(content)
        )

        return Response(MessageSerializer(message).data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=['get'])
    def get_operator_messages(self, request):
        """Get messages for an operator"""
        operator_id = request.query_params.get('operator_id')
        try:
            limit = int(request.query_params.get('limit', 100))
        except (TypeError, ValueError):
            limit = 100

        operator_obj = get_object_or_404(operator_obj, id=operator_id)
        messages = operator_obj.messages.all()[:limit]

        return Response(MessageSerializer(messages, many=True).data)

    @action(detail=True, methods=['patch'])
    def mark_read(self, request, pk=None):
        """Mark message as read"""
        message = self.get_object()
        message.is_read = True
        message.save()
        return Response({'is_read': True})


class BroadcastFileViewSet(viewsets.ModelViewSet):
    """Broadcast files - Tutor sharing files with Operators"""
    queryset = BroadcastFile.objects.all()
    serializer_class = BroadcastFileSerializer
    parser_classes = (MultiPartParser, FormParser, JSONParser)

    def get_queryset(self):
        queryset = super().get_queryset()
        session_id = self.request.query_params.get('session_id')
        if session_id:
            queryset = queryset.filter(session_id=session_id)
        return queryset
    
    @action(detail=False, methods=['post'])
    def upload_file(self, request):
        """Upload a file for broadcasting"""
        session_id = request.data.get('session_id')
        file = request.FILES.get('file')
        description = request.data.get('description', '')
        
        if not file:
            return Response({'error': 'No file provided'}, status=status.HTTP_400_BAD_REQUEST)
        
        session = get_object_or_404(Session, id=session_id)
        enforce_session_token(request, session)
        
        # Determine file type
        filename = file.name.lower()
        if filename.endswith(('.pdf',)):
            file_type = 'pdf'
        elif filename.endswith(('.ppt', '.pptx')):
            file_type = 'presentation'
        elif filename.endswith(('.doc', '.docx')):
            file_type = 'document'
        elif filename.endswith(('.jpg', '.jpeg', '.png', '.gif', '.bmp')):
            file_type = 'image'
        else:
            file_type = 'file'
        
        broadcast_file = BroadcastFile.objects.create(
            session=session,
            filename=file.name,
            file=file,
            file_type=file_type,
            description=description
        )
        
        return Response(BroadcastFileSerializer(broadcast_file, context={'request': request}).data, status=status.HTTP_201_CREATED)
    
    @action(detail=False, methods=['get'])
    def get_session_files(self, request):
        """Get broadcast files for a session"""
        session_id = request.query_params.get('session_id')
        session = get_object_or_404(Session, id=session_id)
        files = session.broadcast_files.all()
        return Response(BroadcastFileSerializer(files, many=True, context={'request': request}).data)
    
    @action(detail=True, methods=['post'])
    def set_active(self, request, pk=None):
        """Set file as active broadcast"""
        broadcast_file = self.get_object()
        session = broadcast_file.session
        enforce_session_token(request, session)
        
        # Deactivate all other files
        BroadcastFile.objects.filter(session=session).update(is_active=False)
        
        # Activate this file
        broadcast_file.is_active = True
        broadcast_file.save()

        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f'session_{session.id}',
            {
                'type': 'file_broadcast',
                'file_id': str(broadcast_file.id),
                'filename': broadcast_file.filename,
            }
        )
        
        return Response({'is_active': True})

    @action(detail=True, methods=['post'])
    def toggle_active(self, request, pk=None):
        """Backward-compatible alias for set_active."""
        broadcast_file = self.get_object()
        session = broadcast_file.session
        enforce_session_token(request, session)

        next_state = not broadcast_file.is_active if 'enabled' not in request.data else _coerce_bool(request.data.get('enabled'))
        if next_state:
            BroadcastFile.objects.filter(session=session).update(is_active=False)
        broadcast_file.is_active = next_state
        broadcast_file.save(update_fields=['is_active'])

        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f'session_{session.id}',
            {
                'type': 'file_broadcast',
                'file_id': str(broadcast_file.id),
                'filename': broadcast_file.filename,
            }
        )

        return Response({'status': 'success', 'is_active': broadcast_file.is_active})


class CodeExecutionViewSet(viewsets.ModelViewSet):
    """Code execution - Execute Operator code"""
    queryset = CodeExecution.objects.all()
    serializer_class = CodeExecutionSerializer
    
    @action(detail=False, methods=['post'])
    def execute(self, request):
        """Execute code"""
        operator_id = request.data.get('operator_id')
        code = request.data.get('code', '')
        file_id = request.data.get('file_id')

        throttle_request(f"execute:{operator_id}", limit=25, window_seconds=60)
        
        operator_obj = get_object_or_404(operator_obj, id=operator_id)

        if file_id:
            operator_file = get_object_or_404(OperatorFile, id=file_id, operator=operator_obj)
            if code:
                operator_file.content = code
                operator_file.increment_version()
                operator_file.save()
            else:
                code = operator_file.content

        if not code:
            return Response({'error': 'No code provided'}, status=status.HTTP_400_BAD_REQUEST)
        
        try:
            runtime = _ensure_operator_runtime(str(operator_obj.id))
            _sync_operator_workspace(str(operator_obj.id), runtime['workspace_dir'])

            execution_script = runtime['workspace_dir'] / '__edusync_exec__.py'
            execution_script.write_text(code, encoding='utf-8')
            start_time = time.time()
            result = subprocess.run(
                [str(runtime['python_executable']), '-I', str(execution_script)],
                capture_output=True,
                text=True,
                timeout=8,
                cwd=str(runtime['workspace_dir']),
                env=runtime['env'],
            )
            execution_time = time.time() - start_time
            
            execution = CodeExecution.objects.create(
                operator=operator_obj,
                code=code,
                stdout=result.stdout,
                stderr=result.stderr,
                return_code=result.returncode,
                execution_time=execution_time,
                success=result.returncode == 0
            )
            
            return Response(CodeExecutionSerializer(execution).data, status=status.HTTP_201_CREATED)
        except subprocess.TimeoutExpired:
            execution = CodeExecution.objects.create(
                operator=operator_obj,
                code=code,
                stderr='Code execution timed out',
                return_code=1,
                success=False
            )
            return Response(CodeExecutionSerializer(execution).data, status=status.HTTP_201_CREATED)
        except Exception as e:
            execution = CodeExecution.objects.create(
                operator=operator_obj,
                code=code,
                stderr=str(e),
                return_code=1,
                success=False
            )
            return Response(CodeExecutionSerializer(execution).data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=['post'])
    def run_terminal(self, request):
        """Run terminal command in Operator's persistent runtime/workspace."""
        operator_id = request.data.get('operator_id')
        command = (request.data.get('command') or '').strip()

        if not operator_id or not command:
            return Response({'error': 'operator_id and command required'}, status=status.HTTP_400_BAD_REQUEST)

        throttle_request(f"terminal:{operator_id}", limit=45, window_seconds=60)

        operator_obj = get_object_or_404(operator_obj, id=operator_id)

        try:
            runtime = _ensure_operator_runtime(str(operator_obj.id))
            start_time = time.time()

            # Convenience: allow plain "pip ..." while still using Operator's own venv.
            normalized_command = command
            if command.startswith('pip '):
                normalized_command = f'python -m {command}'

            result = subprocess.run(
                normalized_command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=120,
                cwd=str(runtime['workspace_dir']),
                env=runtime['env'],
            )
            execution_time = time.time() - start_time

            execution = CodeExecution.objects.create(
                operator=operator_obj,
                code=f'$ {command}',
                stdout=result.stdout,
                stderr=result.stderr,
                return_code=result.returncode,
                execution_time=execution_time,
                success=result.returncode == 0,
            )

            payload = CodeExecutionSerializer(execution).data
            payload['cwd'] = str(runtime['workspace_dir'])
            payload['venv'] = str(runtime['venv_dir'])
            return Response(payload, status=status.HTTP_201_CREATED)
        except subprocess.TimeoutExpired:
            return Response(
                {'error': 'Command timed out after 120s'},
                status=status.HTTP_408_REQUEST_TIMEOUT,
            )
        except Exception as e:
            return Response({'error': f'Terminal command failed: {str(e)}'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
    
    @action(detail=False, methods=['get'])
    def get_operator_executions(self, request):
        """Get execution history for operator"""
        operator_id = request.query_params.get('operator_id')
        try:
            limit = int(request.query_params.get('limit', 50))
        except (TypeError, ValueError):
            limit = 50
        
        operator_obj = get_object_or_404(operator_obj, id=operator_id)
        executions = operator_obj.executions.all()[:limit]
        
        return Response(CodeExecutionSerializer(executions, many=True).data)


class AISuggestionViewSet(viewsets.ModelViewSet):
    """AI suggestions - Get code suggestions from Gemini"""
    queryset = AISuggestion.objects.all()
    serializer_class = AISuggestionSerializer

    def _build_prompt(self, code: str, prompt: str, model_choice: str) -> str:
        model_label = model_choice or 'gemini-pro'
        return f"""You are a Python coding tutor. Model selected: {model_label}. Analyze this code and provide helpful suggestions:

```python
{code}
```

{f'Operator asked: {prompt}' if prompt else 'Provide general suggestions for improvement.'}

Keep your response concise and educational.
"""

    def _generate_with_ollama(self, model_name: str, prompt_text: str) -> str:
        return _generate_with_ollama(model_name, prompt_text)
    
    @action(detail=False, methods=['post'])
    def get_suggestion(self, request):
        """Get AI suggestion for code"""
        operator_id = request.data.get('operator_id')
        code = request.data.get('code', '')
        prompt = request.data.get('prompt', '')
        model_choice = (request.data.get('model') or 'gemini-pro').strip()

        throttle_request(f"ai:{operator_id}", limit=12, window_seconds=60)
        
        if not code:
            return Response({'error': 'No code provided'}, status=status.HTTP_400_BAD_REQUEST)
        
        operator_obj = get_object_or_404(operator_obj, id=operator_id)
        session = operator_obj.session
        
        if not session.ai_enabled:
            return Response({'error': 'AI disabled for this session'}, status=status.HTTP_403_FORBIDDEN)
        
        try:
            full_prompt = self._build_prompt(code, prompt, model_choice)

            if model_choice.startswith('ollama:'):
                model_name = model_choice.split('ollama:', 1)[1].strip()
                if not model_name:
                    return Response({'error': 'No local model name provided'}, status=status.HTTP_400_BAD_REQUEST)
                suggestion_text = self._generate_with_ollama(model_name, full_prompt)
            else:
                if not GEMINI_AVAILABLE:
                    return Response({'error': 'AI not available'}, status=status.HTTP_503_SERVICE_UNAVAILABLE)

                model = genai.GenerativeModel('gemini-pro')
                response = model.generate_content(full_prompt)
                suggestion_text = (response.text or '').strip()

            if not suggestion_text:
                suggestion_text = 'No suggestion returned.'
            
            suggestion = AISuggestion.objects.create(
                operator=operator_obj,
                code_context=code,
                prompt=prompt,
                suggestion=encrypt_text(suggestion_text)
            )
            
            return Response(AISuggestionSerializer(suggestion).data, status=status.HTTP_201_CREATED)
        except Exception as e:
            return Response({'error': f'AI suggestion failed: {str(e)}'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @action(detail=False, methods=['post'])
    def generate_test(self, request):
        """Generate a structured test (MCQ / TrueFalse / Practical) using the configured model.
        Expected payload: session_id, topic, mcq_count, tf_count, practical_count, difficulty, model
        Returns: JSON structure with `title`, `questions` array where each question has
        `id`, `type` ('mcq'|'tf'|'practical'), `prompt`, `choices` (for mcq), `correct_answer`, `points`, `rubric`.
        """
        session_id = request.data.get('session_id')
        topic = (request.data.get('topic') or '').strip()
        mcq_count = int(request.data.get('mcq_count') or 0)
        tf_count = int(request.data.get('tf_count') or 0)
        practical_count = int(request.data.get('practical_count') or 0)
        difficulty = (request.data.get('difficulty') or 'medium').strip()
        model_choice = (request.data.get('model') or 'gemini-pro').strip()

        session = get_object_or_404(Session, id=session_id)
        enforce_session_token(request, session)

        if not session.ai_enabled:
            return Response({'error': 'AI disabled for this session'}, status=status.HTTP_403_FORBIDDEN)

        try:
            prompt_text = (
                f"Create a test on the topic: {topic}. Difficulty: {difficulty}. "
                f"Include {mcq_count} multiple-choice questions, {tf_count} true/false questions, "
                f"and {practical_count} practical (open-ended) tasks. "
                "Return only valid JSON with the following schema:\n"
                "{\"title\": string, \"questions\": [{\"id\": int, \"type\": \"mcq|tf|practical\", \"prompt\": string, "
                "\"choices\": [string], \"correct_answer\": string|bool, \"points\": int, \"rubric\": string}]}\n"
                "For MCQs, include 3-5 plausible choices. For practical tasks, include a short grading rubric and expected points. "
                "Do not include any explanatory text outside the JSON."
            )

            # choose model
            if model_choice.startswith('ollama:'):
                model_name = model_choice.split('ollama:', 1)[1].strip()
                raw = self._generate_with_ollama(model_name, prompt_text)
            else:
                if not GEMINI_AVAILABLE:
                    return Response({'error': 'AI not available'}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
                model = genai.GenerativeModel(model_choice or 'gemini-pro')
                response = model.generate_content(prompt_text)
                raw = (response.text or '').strip()

            # try to parse JSON from model output
            parsed = None
            try:
                parsed = json.loads(raw)
            except Exception:
                # fallback: try to extract first JSON object
                start = raw.find('{')
                end = raw.rfind('}')
                if start != -1 and end != -1 and end > start:
                    try:
                        parsed = json.loads(raw[start:end+1])
                    except Exception:
                        parsed = None

            if not parsed:
                return Response({'error': 'AI returned non-JSON response', 'raw': raw}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

            return Response(parsed)
        except Exception as e:
            return Response({'error': f'Test generation failed: {str(e)}'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @action(detail=False, methods=['post'])
    def grade_test(self, request):
        """Grade a test using deterministic checks for MCQ/TF and AI-assisted grading for practicals.
        Payload: session_id, operator_id, test (JSON as generated), answers: {question_id: answer}
        Returns: per-question scores, feedback, and total.
        """
        session_id = request.data.get('session_id')
        operator_id = request.data.get('operator_id')
        test = request.data.get('test')
        answers = request.data.get('answers') or {}
        model_choice = (request.data.get('model') or 'gemini-pro').strip()

        session = get_object_or_404(Session, id=session_id)
        enforce_session_token(request, session)

        if not session.ai_enabled:
            return Response({'error': 'AI disabled for this session'}, status=status.HTTP_403_FORBIDDEN)

        try:
            questions = test.get('questions', []) if isinstance(test, dict) else []
            results = []
            total_points = 0
            earned = 0

            for q in questions:
                qid = q.get('id')
                qtype = q.get('type')
                points = int(q.get('points') or 1)
                total_points += points
                Operator_answer = answers.get(str(qid)) if isinstance(answers, dict) else None

                if qtype in ('mcq',):
                    correct = str(q.get('correct_answer')).strip()
                    given = str(Operator_answer).strip() if Operator_answer is not None else ''
                    score = points if given and given.lower() == correct.lower() else 0
                    feedback = 'Correct' if score == points else f'Incorrect (expected {correct})'
                elif qtype in ('tf', 'truefalse'):
                    correct_bool = bool(q.get('correct_answer') is True)
                    given_bool = str(Operator_answer).strip().lower() in {'1', 'true', 'yes', 't'} if Operator_answer is not None else False
                    score = points if given_bool == correct_bool else 0
                    feedback = 'Correct' if score == points else f'Incorrect (expected {correct_bool})'
                else:
                    # practical: use AI to score against rubric
                    rubric = q.get('rubric', '')
                    Operator_resp = Operator_answer or ''
                    prompt_text = (
                        f"You are a grader. Grade the operator's answer against the rubric.\n\n"
                        f"Question:\n{q.get('prompt')}\n\n"
                        f"Rubric:\n{rubric}\n\n"
                        f"Operator answer:\n{Operator_resp}\n\n"
                        f"Return only JSON with format: {{'score': int 0..{points}, 'feedback': string}}\n"
                    )

                    if model_choice.startswith('ollama:'):
                        model_name = model_choice.split('ollama:', 1)[1].strip()
                        ai_raw = _generate_with_ollama(model_name, prompt_text)
                    else:
                        if not GEMINI_AVAILABLE:
                            return Response({'error': 'AI not available for grading'}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
                        model = genai.GenerativeModel(model_choice or 'gemini-pro')
                        response = model.generate_content(prompt_text)
                        ai_raw = (response.text or '').strip()

                    ai_parsed = None
                    try:
                        ai_parsed = json.loads(ai_raw)
                    except Exception:
                        s = ai_raw.find('{')
                        e = ai_raw.rfind('}')
                        if s != -1 and e != -1 and e > s:
                            try:
                                ai_parsed = json.loads(ai_raw[s:e+1])
                            except Exception:
                                ai_parsed = None

                    if ai_parsed and isinstance(ai_parsed, dict):
                        score = int(ai_parsed.get('score') or 0)
                        feedback = ai_parsed.get('feedback') or ''
                    else:
                        # fallback: zero with generic feedback
                        score = 0
                        feedback = f'Could not parse AI grading output. Raw: {ai_raw[:400]}'

                earned += int(score)
                results.append({
                    'id': qid,
                    'type': qtype,
                    'points': points,
                    'score': int(score),
                    'feedback': feedback,
                })

            return Response({'total_points': total_points, 'earned': earned, 'results': results})
        except Exception as e:
            return Response({'error': f'Grading failed: {str(e)}'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
    
    @action(detail=True, methods=['patch'])
    def mark_helpful(self, request, pk=None):
        """Mark suggestion as helpful"""
        suggestion = self.get_object()
        suggestion.was_helpful = request.data.get('was_helpful', True)
        suggestion.save()
        return Response({'was_helpful': suggestion.was_helpful})
    
    @action(detail=False, methods=['get'])
    def get_autocomplete_context(self, request):
        """Get autocomplete context for editor"""
        module_name = request.query_params.get('module', '').strip()
        catalog = _autocomplete_catalog()
        
        payload = {
            'python_keywords': catalog['python_keywords'],
            'installed_modules': catalog['installed_modules'],
            'django_terms': catalog['django_terms'],
            'project_tree': catalog['project_tree'],
            'project_paths': catalog['project_paths'],
            'project_names': catalog['project_names'],
        }
        
        if module_name:
            payload['module_name'] = module_name
            payload['module_attributes'] = _module_attributes(module_name)
        
        return Response(payload)


class TestViewSet(viewsets.ModelViewSet):
    """Manage stored tests and Operator submissions."""
    queryset = Test.objects.all()
    serializer_class = None

    def get_queryset(self):
        queryset = super().get_queryset()
        session_id = self.request.query_params.get('session_id')
        if session_id:
            queryset = queryset.filter(session_id=session_id)
        return queryset

    def list(self, request, *args, **kwargs):
        session_id = request.query_params.get('session_id')
        if not session_id:
            return Response({'error': 'session_id required'}, status=status.HTTP_400_BAD_REQUEST)
        tests = Test.objects.filter(session_id=session_id)
        return Response([{ 'id': str(t.id), 'title': t.title, 'created_at': t.created_at, 'content': t.content } for t in tests])

    def retrieve(self, request, pk=None):
        test = get_object_or_404(Test, id=pk)
        return Response({'id': str(test.id), 'title': test.title, 'content': test.content, 'created_at': test.created_at})

    def create(self, request):
        session_id = request.data.get('session_id')
        title = (request.data.get('title') or 'AI Generated Test').strip()
        content = request.data.get('content') or request.data.get('test')
        if not session_id or not content:
            return Response({'error': 'session_id and content required'}, status=status.HTTP_400_BAD_REQUEST)
        session = get_object_or_404(Session, id=session_id)
        enforce_session_token(request, session)
        test = Test.objects.create(session=session, title=title, content=content, created_by=request.data.get('created_by', 'admin'))
        return Response({'id': str(test.id), 'title': test.title, 'content': test.content, 'created_at': test.created_at}, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=['post'])
    def submit(self, request):
        test_id = request.data.get('test_id') or request.data.get('id')
        operator_id = request.data.get('operator_id')
        answers = request.data.get('answers') or {}
        model_choice = (request.data.get('model') or 'gemini-pro').strip()

        if not test_id or not operator_id:
            return Response({'error': 'test_id and operator_id required'}, status=status.HTTP_400_BAD_REQUEST)

        test = get_object_or_404(Test, id=test_id)
        operator_obj = get_object_or_404(operator_obj, id=operator_id)

        # create submission
        submission = TestSubmission.objects.create(test=test, operator=operator_obj, answers=answers)

        # grading logic (same approach as AISuggestionViewSet.grade_test)
        try:
            questions = test.content.get('questions', []) if isinstance(test.content, dict) else []
            results = []
            total_points = 0
            earned = 0

            for q in questions:
                qid = q.get('id')
                qtype = q.get('type')
                points = int(q.get('points') or 1)
                total_points += points
                Operator_answer = answers.get(str(qid)) if isinstance(answers, dict) else None

                if qtype in ('mcq',):
                    correct = str(q.get('correct_answer')).strip()
                    given = str(Operator_answer).strip() if Operator_answer is not None else ''
                    score = points if given and given.lower() == correct.lower() else 0
                    feedback = 'Correct' if score == points else f'Incorrect (expected {correct})'
                elif qtype in ('tf', 'truefalse'):
                    correct_bool = bool(q.get('correct_answer') is True)
                    given_bool = str(Operator_answer).strip().lower() in {'1', 'true', 'yes', 't'} if Operator_answer is not None else False
                    score = points if given_bool == correct_bool else 0
                    feedback = 'Correct' if score == points else f'Incorrect (expected {correct_bool})'
                else:
                    rubric = q.get('rubric', '')
                    Operator_resp = Operator_answer or ''
                    prompt_text = (
                        f"You are a grader. Grade the operator's answer against the rubric.\n\n"
                        f"Question:\n{q.get('prompt')}\n\n"
                        f"Rubric:\n{rubric}\n\n"
                        f"Operator answer:\n{Operator_resp}\n\n"
                        f"Return only JSON with format: {{'score': int 0..{points}, 'feedback': string}}\n"
                    )

                    if model_choice.startswith('ollama:'):
                        model_name = model_choice.split('ollama:', 1)[1].strip()
                        ai_raw = self._generate_with_ollama(model_name, prompt_text)
                    else:
                        if not GEMINI_AVAILABLE:
                            return Response({'error': 'AI not available for grading'}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
                        model = genai.GenerativeModel(model_choice or 'gemini-pro')
                        response = model.generate_content(prompt_text)
                        ai_raw = (response.text or '').strip()

                    ai_parsed = None
                    try:
                        ai_parsed = json.loads(ai_raw)
                    except Exception:
                        s = ai_raw.find('{')
                        e = ai_raw.rfind('}')
                        if s != -1 and e != -1 and e > s:
                            try:
                                ai_parsed = json.loads(ai_raw[s:e+1])
                            except Exception:
                                ai_parsed = None

                    if ai_parsed and isinstance(ai_parsed, dict):
                        score = int(ai_parsed.get('score') or 0)
                        feedback = ai_parsed.get('feedback') or ''
                    else:
                        score = 0
                        feedback = f'Could not parse AI grading output. Raw: {ai_raw[:400]}'

                earned += int(score)
                results.append({
                    'id': qid,
                    'type': qtype,
                    'points': points,
                    'score': int(score),
                    'feedback': feedback,
                })

            grade_payload = {'total_points': total_points, 'earned': earned, 'results': results}
            submission.graded = True
            submission.grade_result = grade_payload
            submission.graded_at = timezone.now()
            submission.save()

            return Response({'submission_id': str(submission.id), 'grade': grade_payload})
        except Exception as e:
            return Response({'error': f'Grading failed: {str(e)}'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


class SessionTaskViewSet(viewsets.ModelViewSet):
    """Realtime task management for tutor and Operators."""

    queryset = SessionTask.objects.select_related('session', 'assigned_operator').all()
    serializer_class = SessionTaskSerializer

    def _broadcast_task_event(self, session_id: str, event_type: str, task):
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f'session_{session_id}',
            {
                'type': 'task_updated',
                'event': event_type,
                'task': SessionTaskSerializer(task).data,
            },
        )

    @action(detail=False, methods=['get'])
    def by_session(self, request):
        session_id = request.query_params.get('session_id')
        if not session_id:
            return Response({'error': 'session_id required'}, status=status.HTTP_400_BAD_REQUEST)

        tasks = self.queryset.filter(session_id=session_id)
        return Response(SessionTaskSerializer(tasks, many=True).data)

    @action(detail=False, methods=['post'])
    def create_task(self, request):
        session_id = request.data.get('session_id')
        title = (request.data.get('title') or '').strip()
        if not session_id or not title:
            return Response({'error': 'session_id and title required'}, status=status.HTTP_400_BAD_REQUEST)

        session = get_object_or_404(Session, id=session_id)
        enforce_session_token(request, session)

        assigned_operator_id = request.data.get('assigned_operator_id')
        assigned_operator = None
        if assigned_operator_id:
            assigned_operator = get_object_or_404(operator_obj, id=assigned_operator_id, session=session)

        task = SessionTask.objects.create(
            session=session,
            assigned_operator=assigned_operator,
            title=title,
            description=request.data.get('description', ''),
            status=request.data.get('status', 'todo'),
            priority=request.data.get('priority', 'medium'),
            created_by=request.data.get('created_by', 'admin'),
            due_at=request.data.get('due_at') or None,
        )

        self._broadcast_task_event(str(session.id), 'created', task)
        return Response(SessionTaskSerializer(task).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['patch'])
    def update_task(self, request, pk=None):
        task = self.get_object()
        enforce_session_token(request, task.session)

        if 'title' in request.data:
            task.title = request.data.get('title') or task.title
        if 'description' in request.data:
            task.description = request.data.get('description') or ''
        if 'status' in request.data:
            task.status = request.data.get('status') or task.status
        if 'priority' in request.data:
            task.priority = request.data.get('priority') or task.priority
        if 'due_at' in request.data:
            task.due_at = request.data.get('due_at') or None

        if 'assigned_operator_id' in request.data:
            assigned_operator_id = request.data.get('assigned_operator_id')
            if assigned_operator_id:
                task.assigned_operator = get_object_or_404(
                    Operator,
                    id=assigned_operator_id,
                    session=task.session,
                )
            else:
                task.assigned_operator = None

        task.bump_version()
        task.save()

        self._broadcast_task_event(str(task.session.id), 'updated', task)
        return Response(SessionTaskSerializer(task).data)

    @action(detail=True, methods=['post'])
    def mark_done(self, request, pk=None):
        task = self.get_object()
        enforce_session_token(request, task.session)
        task.status = 'done'
        task.bump_version()
        task.save()
        self._broadcast_task_event(str(task.session.id), 'done', task)
        return Response(SessionTaskSerializer(task).data)


def network_info(request):
    """Return the LAN IP and direct frontend/backend URLs for sharing."""
    lan_ip = _detect_lan_ip()
    scheme = 'https' if request.is_secure() else 'http'
    return JsonResponse({
        'lan_ip': lan_ip,
        'frontend_url': f'{scheme}://{lan_ip}:3000',
        'backend_url': f'{scheme}://{lan_ip}:8000/api/',
    })

