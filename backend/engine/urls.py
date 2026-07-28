"""
ZTCE REST API URL Configuration
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
40+ API endpoints organized via DRF ViewSet routers.
"""

from django.urls import path, include
from rest_framework.routers import DefaultRouter
from . import views

router = DefaultRouter()
router.register(r'sessions', views.SessionViewSet, basename='session')
router.register(r'operators', views.OperatorViewSet, basename='operator')
router.register(r'files', views.OperatorFileViewSet, basename='file')
router.register(r'activities', views.ActivityLogViewSet, basename='activity')
router.register(r'snapshots', views.CodeSnapshotViewSet, basename='snapshot')
router.register(r'messages', views.MessageViewSet, basename='message')
router.register(r'broadcasts', views.BroadcastFileViewSet, basename='broadcast')
router.register(r'executions', views.CodeExecutionViewSet, basename='execution')
router.register(r'suggestions', views.AISuggestionViewSet, basename='suggestion')
router.register(r'tests', views.TestViewSet, basename='test')
router.register(r'tasks', views.SessionTaskViewSet, basename='task')

urlpatterns = [
    path('', include(router.urls)),
    path('network-info/', views.network_info, name='network-info'),
]
