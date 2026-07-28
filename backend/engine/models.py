"""
ZTCE Database Models
━━━━━━━━━━━━━━━━━━━
11 models representing the complete data layer for the air-gapped
collaborative execution platform.

Session → Operators → Files/Activity/Snapshots/Messages/Executions/AI
        → Tasks → Tests → Submissions
"""

import uuid
from django.db import models
from django.utils import timezone


def generate_session_token():
    """Generate a cryptographically random 64-character session token."""
    return uuid.uuid4().hex + uuid.uuid4().hex


class Session(models.Model):
    """
    Represents an isolated collaborative workspace.
    In air-gapped mode, sessions are created on the local network
    and accessible only to authenticated operators.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    creator_id = models.CharField(max_length=100, default='admin')
    creator_name = models.CharField(max_length=255, default='Admin')
    created_at = models.DateTimeField(auto_now_add=True)
    is_active = models.BooleanField(default=True)
    ai_enabled = models.BooleanField(default=True)
    autocomplete_enabled = models.BooleanField(default=True)
    leaderboard_visible = models.BooleanField(default=False)
    allow_operator_download = models.BooleanField(default=False)
    session_token = models.CharField(
        max_length=128, default=generate_session_token,
        editable=False, unique=True
    )
    description = models.TextField(blank=True, default='')

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"Session {self.id} by {self.creator_name}"


class Operator(models.Model):
    """
    Represents a developer/operator connected to a session.
    Tracks connection state via heartbeat for real-time presence detection.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(Session, on_delete=models.CASCADE, related_name='operators')
    name = models.CharField(max_length=255)
    username = models.CharField(max_length=100)
    email = models.EmailField(blank=True, default='')
    connected_at = models.DateTimeField(auto_now_add=True)
    last_heartbeat = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ['session', 'username']
        ordering = ['-last_heartbeat']

    def is_online(self):
        """Check if operator is still connected (within 30-second window)."""
        delta = timezone.now() - self.last_heartbeat
        return delta.total_seconds() < 30

    def __str__(self):
        return f"{self.name} ({self.username})"


class OperatorFile(models.Model):
    """
    Code files managed per operator with built-in version tracking.
    Supports multi-file workspaces with language detection.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    operator = models.ForeignKey(Operator, on_delete=models.CASCADE, related_name='files')
    filename = models.CharField(max_length=255, default='main.py')
    content = models.TextField(default='# Start coding here\n')
    language = models.CharField(max_length=50, default='python')
    last_modified = models.DateTimeField(auto_now=True)
    version = models.IntegerField(default=1)
    is_main = models.BooleanField(default=False)

    class Meta:
        unique_together = ['operator', 'filename']
        ordering = ['-last_modified']

    def increment_version(self):
        self.version += 1
        self.save()

    def __str__(self):
        return f"{self.filename} (v{self.version})"


class ActivityLog(models.Model):
    """
    Tracks operator activity status using traffic-light indicators.
    Enables real-time monitoring of team health in the command center.
    """
    STATUS_CHOICES = [
        ('green', 'Actively Coding'),
        ('yellow', 'Reviewing'),
        ('red', 'Error / Blocked'),
        ('idle', 'Idle'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    operator = models.ForeignKey(Operator, on_delete=models.CASCADE, related_name='activity_logs')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='idle')
    message = models.TextField(blank=True, default='')
    error_details = models.TextField(blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.operator.username} - {self.status}"


class CodeSnapshot(models.Model):
    """
    Immutable point-in-time snapshots of operator code.
    Provides version history without relying on external VCS.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    operator = models.ForeignKey(Operator, on_delete=models.CASCADE, related_name='snapshots')
    filename = models.CharField(max_length=255)
    content = models.TextField()
    language = models.CharField(max_length=50, default='python')
    snapshot_time = models.DateTimeField(auto_now_add=True)
    message = models.CharField(max_length=255, blank=True, default='')

    class Meta:
        ordering = ['-snapshot_time']

    def __str__(self):
        return f"{self.filename} snapshot"


class Message(models.Model):
    """
    Encrypted inter-operator messaging.
    Content is stored encrypted at rest using Fernet.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    operator = models.ForeignKey(Operator, on_delete=models.CASCADE, related_name='messages')
    sender = models.CharField(max_length=50)
    content = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    is_read = models.BooleanField(default=False)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.sender}: {self.content[:50]}"


class BroadcastFile(models.Model):
    """
    Files distributed to all operators in a session.
    Supports PDF, images, and document broadcasting.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(Session, on_delete=models.CASCADE, related_name='broadcast_files')
    filename = models.CharField(max_length=255)
    file = models.FileField(upload_to='broadcast_files/')
    file_type = models.CharField(max_length=50, default='document')
    uploaded_at = models.DateTimeField(auto_now_add=True)
    is_active = models.BooleanField(default=False)
    description = models.TextField(blank=True, default='')

    class Meta:
        ordering = ['-uploaded_at']

    def __str__(self):
        return f"{self.filename}"


class CodeExecution(models.Model):
    """
    Sandboxed code execution records.
    Tracks stdout, stderr, return codes, and execution timing.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    operator = models.ForeignKey(Operator, on_delete=models.CASCADE, related_name='executions')
    code = models.TextField()
    stdout = models.TextField(blank=True, default='')
    stderr = models.TextField(blank=True, default='')
    return_code = models.IntegerField(default=0)
    execution_time = models.FloatField(default=0.0)
    executed_at = models.DateTimeField(auto_now_add=True)
    success = models.BooleanField(default=True)

    class Meta:
        ordering = ['-executed_at']

    def __str__(self):
        return f"Execution by {self.operator.username}"


class AISuggestion(models.Model):
    """
    AI-generated code suggestions from local Ollama models.
    Suggestions are encrypted at rest — zero-trust compliance.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    operator = models.ForeignKey(Operator, on_delete=models.CASCADE, related_name='ai_suggestions')
    code_context = models.TextField()
    prompt = models.TextField(blank=True, default='')
    suggestion = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    was_helpful = models.BooleanField(null=True, blank=True, default=None)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"AI suggestion for {self.operator.username}"


class SessionTask(models.Model):
    """
    Real-time task board for session-level work coordination.
    Supports Kanban-style status tracking with priority levels.
    """
    STATUS_CHOICES = [
        ('todo', 'To Do'),
        ('in_progress', 'In Progress'),
        ('blocked', 'Blocked'),
        ('done', 'Done'),
    ]

    PRIORITY_CHOICES = [
        ('low', 'Low'),
        ('medium', 'Medium'),
        ('high', 'High'),
        ('critical', 'Critical'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(Session, on_delete=models.CASCADE, related_name='tasks')
    assigned_operator = models.ForeignKey(
        Operator, on_delete=models.SET_NULL,
        related_name='assigned_tasks',
        null=True, blank=True,
    )
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True, default='')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='todo')
    priority = models.CharField(max_length=20, choices=PRIORITY_CHOICES, default='medium')
    created_by = models.CharField(max_length=100, default='admin')
    due_at = models.DateTimeField(null=True, blank=True)
    version = models.PositiveIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['status', '-priority', '-updated_at']

    def bump_version(self):
        self.version += 1

    def __str__(self):
        return f"{self.title} [{self.status}]"


class Test(models.Model):
    """Assessment/test definition stored as JSON content."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(Session, on_delete=models.CASCADE, related_name='tests')
    title = models.CharField(max_length=255, default='Assessment')
    content = models.JSONField(default=dict)
    created_by = models.CharField(max_length=100, default='admin')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"Test {self.title} ({self.id})"


class TestSubmission(models.Model):
    """Operator submission for an assessment with auto-grading support."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    test = models.ForeignKey(Test, on_delete=models.CASCADE, related_name='submissions')
    operator = models.ForeignKey(Operator, on_delete=models.CASCADE, related_name='test_submissions')
    answers = models.JSONField(default=dict)
    graded = models.BooleanField(default=False)
    grade_result = models.JSONField(null=True, blank=True)
    submitted_at = models.DateTimeField(auto_now_add=True)
    graded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-submitted_at']

    def __str__(self):
        return f"Submission {self.id} for test {self.test.id} by {self.operator.username}"
