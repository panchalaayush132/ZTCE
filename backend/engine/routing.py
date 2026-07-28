"""WebSocket URL routing for ZTCE real-time sync engine."""

from django.urls import path
from . import consumers

websocket_urlpatterns = [
    path('ws/session/<str:session_id>/', consumers.SessionConsumer.as_asgi()),
    path('ws/operator/<str:operator_id>/', consumers.OperatorConsumer.as_asgi()),
]
