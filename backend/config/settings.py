from pathlib import Path
import os
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent

# SECURITY: Use environment variable in production deployments
SECRET_KEY = os.getenv('ZTCE_SECRET_KEY', 'ztce-dev-key-change-in-production')

# Air-gapped mode: DEBUG should be False in production air-gapped deployments
DEBUG = os.getenv('ZTCE_DEBUG', 'true').lower() == 'true'

# SECURITY: In air-gapped mode, restrict to known local network hosts
ALLOWED_HOSTS = os.getenv('ZTCE_ALLOWED_HOSTS', '*').split(',')

INSTALLED_APPS = [
    'daphne',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'channels',
    'rest_framework',
    'corsheaders',
    'engine',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'config.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'config.wsgi.application'
ASGI_APPLICATION = 'config.asgi.application'

# Database: SQLite for portability in air-gapped environments (zero network dependency)
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': BASE_DIR / 'db.sqlite3',
    }
}

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# ─── Django Channels (ASGI WebSocket Layer) ───────────────────────────────────
# In air-gapped mode, InMemoryChannelLayer is sufficient for single-server deployments.
# For multi-server air-gapped clusters, use Redis on the local network.
USE_REDIS_CHANNEL_LAYERS = os.getenv('USE_REDIS_CHANNEL_LAYERS', 'false').lower() == 'true'

CHANNEL_LAYERS = {
    'default': {
        'BACKEND': (
            'channels_redis.core.RedisChannelLayer'
            if USE_REDIS_CHANNEL_LAYERS
            else 'channels.layers.InMemoryChannelLayer'
        ),
        'CONFIG': (
            {'hosts': [(os.getenv('REDIS_HOST', '127.0.0.1'), 6379)]}
            if USE_REDIS_CHANNEL_LAYERS
            else {}
        ),
    },
}

# ─── Django REST Framework ────────────────────────────────────────────────────
REST_FRAMEWORK = {
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination',
    'PAGE_SIZE': 20,
    'DEFAULT_FILTER_BACKENDS': [
        'rest_framework.filters.SearchFilter',
        'rest_framework.filters.OrderingFilter',
    ],
}

# ─── CORS (local network access) ─────────────────────────────────────────────
CORS_ALLOW_ALL_ORIGINS = True
CORS_ALLOW_HEADERS = [
    'accept',
    'accept-encoding',
    'authorization',
    'content-type',
    'dnt',
    'origin',
    'user-agent',
    'x-csrftoken',
    'x-requested-with',
    'x-session-token',
]

# ─── Zero-Trust AI Configuration ─────────────────────────────────────────────
# OLLAMA_BASE_URL: Points to local Ollama instance for air-gapped AI inference
# No external API keys required — all AI runs on local hardware
OLLAMA_BASE_URL = os.getenv('OLLAMA_BASE_URL', 'http://localhost:11434')
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY', '')  # Optional fallback for non-air-gapped mode

# ─── Media files ──────────────────────────────────────────────────────────────
MEDIA_URL = '/media/'
MEDIA_ROOT = BASE_DIR / 'media'

# Allow collaborative document viewing in embedded frames
X_FRAME_OPTIONS = 'ALLOWALL'

# ─── Encryption Key ──────────────────────────────────────────────────────────
# Used for Fernet encryption of sensitive data at rest
APP_ENCRYPTION_KEY = os.getenv('ZTCE_ENCRYPTION_KEY', '')
