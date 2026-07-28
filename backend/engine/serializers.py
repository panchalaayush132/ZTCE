"""
ZTCE DRF Serializers
━━━━━━━━━━━━━━━━━━━
Serialization layer for all 11 models with computed fields,
nested relationships, and automatic decryption of sensitive data.
"""

from django.utils import timezone
from datetime import timedelta
from rest_framework import serializers
from .models import (
    Session, Operator, OperatorFile, ActivityLog, CodeSnapshot,
    Message, BroadcastFile, CodeExecution, AISuggestion, SessionTask,
    Test, TestSubmission,
)
from .security_utils import decrypt_text


class SessionSerializer(serializers.ModelSerializer):
    operator_count = serializers.SerializerMethodField()
    active_operators = serializers.SerializerMethodField()
    operators = serializers.SerializerMethodField()

    class Meta:
        model = Session
        fields = [
            'id', 'creator_id', 'creator_name', 'created_at', 'is_active',
            'ai_enabled', 'autocomplete_enabled', 'leaderboard_visible',
            'allow_operator_download', 'session_token', 'description',
            'operator_count', 'active_operators', 'operators',
        ]

    def get_operator_count(self, obj):
        return obj.operators.count()

    def get_active_operators(self, obj):
        return obj.operators.filter(
            last_heartbeat__gte=timezone.now() - timedelta(seconds=30)
        ).count()

    def get_operators(self, obj):
        return OperatorSerializer(obj.operators.all(), many=True).data


class OperatorFileSerializer(serializers.ModelSerializer):
    class Meta:
        model = OperatorFile
        fields = ['id', 'filename', 'content', 'language', 'last_modified', 'version', 'is_main']


class OperatorSerializer(serializers.ModelSerializer):
    is_online = serializers.SerializerMethodField()
    files = OperatorFileSerializer(many=True, read_only=True)
    current_activity = serializers.SerializerMethodField()
    session_id = serializers.CharField(source='session.id', read_only=True)

    class Meta:
        model = Operator
        fields = [
            'id', 'session_id', 'name', 'username', 'email',
            'connected_at', 'last_heartbeat', 'is_online',
            'files', 'current_activity',
        ]

    def get_is_online(self, obj):
        return obj.is_online()

    def get_current_activity(self, obj):
        latest = obj.activity_logs.first()
        if latest:
            return {'status': latest.status, 'message': latest.message}
        return None


class ActivityLogSerializer(serializers.ModelSerializer):
    class Meta:
        model = ActivityLog
        fields = ['id', 'status', 'message', 'error_details', 'created_at']


class CodeSnapshotSerializer(serializers.ModelSerializer):
    class Meta:
        model = CodeSnapshot
        fields = ['id', 'filename', 'content', 'language', 'snapshot_time', 'message']


class MessageSerializer(serializers.ModelSerializer):
    content = serializers.SerializerMethodField()

    class Meta:
        model = Message
        fields = ['id', 'sender', 'content', 'created_at', 'is_read']

    def get_content(self, obj):
        """Automatically decrypt message content on read."""
        return decrypt_text(obj.content)


class BroadcastFileSerializer(serializers.ModelSerializer):
    file_url = serializers.SerializerMethodField()

    class Meta:
        model = BroadcastFile
        fields = ['id', 'filename', 'file_url', 'file_type', 'uploaded_at', 'is_active', 'description']

    def get_file_url(self, obj):
        request = self.context.get('request')
        if obj.file and hasattr(obj.file, 'url'):
            return request.build_absolute_uri(obj.file.url) if request else obj.file.url
        return None


class CodeExecutionSerializer(serializers.ModelSerializer):
    class Meta:
        model = CodeExecution
        fields = ['id', 'code', 'stdout', 'stderr', 'return_code', 'execution_time', 'executed_at', 'success']


class AISuggestionSerializer(serializers.ModelSerializer):
    suggestion = serializers.SerializerMethodField()

    class Meta:
        model = AISuggestion
        fields = ['id', 'code_context', 'prompt', 'suggestion', 'created_at', 'was_helpful']

    def get_suggestion(self, obj):
        """Decrypt AI suggestion on read — zero-trust at-rest encryption."""
        return decrypt_text(obj.suggestion)


class SessionTaskSerializer(serializers.ModelSerializer):
    assigned_operator_id = serializers.UUIDField(source='assigned_operator.id', read_only=True)
    assigned_operator_name = serializers.SerializerMethodField()

    class Meta:
        model = SessionTask
        fields = [
            'id', 'session', 'assigned_operator', 'assigned_operator_id',
            'assigned_operator_name', 'title', 'description', 'status',
            'priority', 'created_by', 'due_at', 'version',
            'created_at', 'updated_at',
        ]

    def get_assigned_operator_name(self, obj):
        return obj.assigned_operator.name if obj.assigned_operator else ''


class TestSerializer(serializers.ModelSerializer):
    class Meta:
        model = Test
        fields = ['id', 'session', 'title', 'content', 'created_by', 'created_at']


class TestSubmissionSerializer(serializers.ModelSerializer):
    operator_id = serializers.UUIDField(source='operator.id', read_only=True)
    test_id = serializers.UUIDField(source='test.id', read_only=True)

    class Meta:
        model = TestSubmission
        fields = [
            'id', 'test', 'test_id', 'operator', 'operator_id',
            'answers', 'graded', 'grade_result', 'submitted_at', 'graded_at',
        ]
