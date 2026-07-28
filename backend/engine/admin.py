"""
ZTCE Admin Configuration
━━━━━━━━━━━━━━━━━━━━━━━━
Django admin interface for platform administration and debugging.
"""

from django.contrib import admin
from .models import (
    Session, Operator, OperatorFile, ActivityLog, CodeSnapshot,
    Message, BroadcastFile, CodeExecution, AISuggestion,
    SessionTask, Test, TestSubmission,
)


@admin.register(Session)
class SessionAdmin(admin.ModelAdmin):
    list_display = ['id', 'creator_name', 'created_at', 'is_active', 'ai_enabled']
    list_filter = ['created_at', 'is_active', 'ai_enabled']
    search_fields = ['creator_id', 'creator_name']


@admin.register(Operator)
class OperatorAdmin(admin.ModelAdmin):
    list_display = ['username', 'name', 'session', 'connected_at', 'is_online']
    list_filter = ['connected_at', 'session']
    search_fields = ['username', 'name']


@admin.register(OperatorFile)
class OperatorFileAdmin(admin.ModelAdmin):
    list_display = ['filename', 'operator', 'language', 'version', 'last_modified']
    list_filter = ['language', 'last_modified']
    search_fields = ['filename', 'operator__username']


@admin.register(ActivityLog)
class ActivityLogAdmin(admin.ModelAdmin):
    list_display = ['operator', 'status', 'created_at']
    list_filter = ['status', 'created_at']
    search_fields = ['operator__username']


@admin.register(CodeSnapshot)
class CodeSnapshotAdmin(admin.ModelAdmin):
    list_display = ['filename', 'operator', 'snapshot_time']
    list_filter = ['snapshot_time']
    search_fields = ['filename', 'operator__username']


@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    list_display = ['sender', 'operator', 'created_at', 'is_read']
    list_filter = ['sender', 'is_read', 'created_at']
    search_fields = ['operator__username']


@admin.register(BroadcastFile)
class BroadcastFileAdmin(admin.ModelAdmin):
    list_display = ['filename', 'session', 'file_type', 'uploaded_at', 'is_active']
    list_filter = ['file_type', 'uploaded_at', 'is_active']
    search_fields = ['filename']


@admin.register(CodeExecution)
class CodeExecutionAdmin(admin.ModelAdmin):
    list_display = ['operator', 'executed_at', 'success', 'execution_time']
    list_filter = ['success', 'executed_at']
    search_fields = ['operator__username']


@admin.register(AISuggestion)
class AISuggestionAdmin(admin.ModelAdmin):
    list_display = ['operator', 'created_at', 'was_helpful']
    list_filter = ['created_at', 'was_helpful']
    search_fields = ['operator__username']


@admin.register(SessionTask)
class SessionTaskAdmin(admin.ModelAdmin):
    list_display = ['title', 'session', 'status', 'priority', 'assigned_operator', 'updated_at']
    list_filter = ['status', 'priority', 'created_at']
    search_fields = ['title', 'session__creator_name']


@admin.register(Test)
class TestAdmin(admin.ModelAdmin):
    list_display = ['title', 'session', 'created_by', 'created_at']
    list_filter = ['created_at', 'created_by']
    search_fields = ['title', 'session__creator_name']


@admin.register(TestSubmission)
class TestSubmissionAdmin(admin.ModelAdmin):
    list_display = ['test', 'operator', 'graded', 'submitted_at', 'graded_at']
    list_filter = ['graded', 'submitted_at']
    search_fields = ['operator__username']
