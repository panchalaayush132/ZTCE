from django.http import JsonResponse


def root_view(request):
    """Root API endpoint — ZTCE platform discovery and health check."""
    host = request.get_host().split(':')[0]
    scheme = 'https' if request.is_secure() else 'http'
    frontend_url = f"{scheme}://{host}:3000"

    return JsonResponse({
        "platform": "ZTCE — Zero-Trust Air-Gapped Collaborative Execution Engine",
        "version": "1.0.0",
        "description": "Enterprise-grade air-gapped collaborative development platform",
        "mode": "air-gapped",
        "security": {
            "zero_trust_ai": True,
            "data_encryption": "Fernet (AES-128-CBC)",
            "session_auth": "Token-based header validation",
            "network_isolation": "Full air-gap support",
        },
        "endpoints": {
            "admin": "/admin/",
            "api": "/api/",
            "websocket_session": "/ws/session/<session_id>/",
            "websocket_operator": "/ws/operator/<operator_id>/",
        },
        "quick_start": {
            "step1": "Create a workspace session: POST /api/sessions/create_session/",
            "step2": "Add operators: POST /api/operators/add_operator/",
            "step3": f"Access collaborative IDE at frontend ({frontend_url})",
            "step4": "Monitor activity via WebSocket real-time sync",
        },
    })
