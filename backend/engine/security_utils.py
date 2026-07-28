"""
ZTCE Security Utilities
━━━━━━━━━━━━━━━━━━━━━━
Implements the zero-trust security primitives for the air-gapped platform:

1. Fernet Symmetric Encryption — AES-128-CBC for data at rest
2. Session Token Enforcement  — Header-based authentication
3. Rate Limiting / Throttling — Per-endpoint abuse prevention

All cryptographic operations use keys derived locally. No external key
management services are required, making this module fully operational
in air-gapped environments.
"""

import base64
import hashlib
import time
from collections import deque
from typing import Deque, Dict

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from rest_framework.exceptions import PermissionDenied, Throttled


# ─── Rate Limiting ────────────────────────────────────────────────────────────
_RATE_BUCKETS: Dict[str, Deque[float]] = {}


# ─── Fernet Encryption ───────────────────────────────────────────────────────
def _build_fernet() -> Fernet:
    """
    Construct a Fernet cipher from either APP_ENCRYPTION_KEY env var
    or a SHA-256 derivation of Django's SECRET_KEY.
    """
    raw = getattr(settings, 'APP_ENCRYPTION_KEY', '') or ''
    if raw:
        key_bytes = raw.encode('utf-8')
    else:
        digest = hashlib.sha256(settings.SECRET_KEY.encode('utf-8')).digest()
        key_bytes = base64.urlsafe_b64encode(digest)
    return Fernet(key_bytes)


_FERNET = _build_fernet()
_ENCRYPT_PREFIX = 'enc::'


def encrypt_text(value: str) -> str:
    """Encrypt a plaintext string using Fernet symmetric encryption."""
    if not value:
        return value
    if value.startswith(_ENCRYPT_PREFIX):
        return value  # Already encrypted
    token = _FERNET.encrypt(value.encode('utf-8')).decode('utf-8')
    return f'{_ENCRYPT_PREFIX}{token}'


def decrypt_text(value: str) -> str:
    """Decrypt a Fernet-encrypted string. Returns empty string on failure."""
    if not value:
        return value
    if not value.startswith(_ENCRYPT_PREFIX):
        return value  # Not encrypted, return as-is
    token = value[len(_ENCRYPT_PREFIX):]
    try:
        return _FERNET.decrypt(token.encode('utf-8')).decode('utf-8')
    except (InvalidToken, ValueError):
        return ''


# ─── Session Token Authentication ────────────────────────────────────────────
def enforce_session_token(request, session) -> None:
    """
    Validate the X-Session-Token header against the session's stored token.
    Raises PermissionDenied if the token is missing or invalid.
    """
    header_token = request.headers.get('X-Session-Token', '').strip()
    if not header_token or header_token != session.session_token:
        raise PermissionDenied('Invalid or missing session token')


# ─── Rate Limiter ─────────────────────────────────────────────────────────────
def throttle_request(bucket_key: str, limit: int = 40, window_seconds: int = 60) -> None:
    """
    Sliding-window rate limiter. Tracks requests per bucket_key.
    Raises Throttled if the limit is exceeded within the window.
    """
    now = time.time()
    bucket = _RATE_BUCKETS.setdefault(bucket_key, deque())

    cutoff = now - window_seconds
    while bucket and bucket[0] < cutoff:
        bucket.popleft()

    if len(bucket) >= limit:
        raise Throttled(detail='Rate limit exceeded', wait=window_seconds)

    bucket.append(now)
