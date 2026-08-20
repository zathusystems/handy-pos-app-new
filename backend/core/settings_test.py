"""
Test settings for local MRA EIS dry-run verification.

This profile intentionally forces:
- SQLite database (no PostgreSQL dependency)
- TEST mode + dry-run safety
"""

from __future__ import annotations

import os

os.environ.setdefault('DEBUG', 'True')
os.environ.setdefault('ENVIRONMENT', 'development')
os.environ.setdefault('ALLOW_INSECURE_LOCAL', 'True')
os.environ.setdefault('MRA_EIS_MODE', 'TEST')
os.environ.setdefault('MRA_EIS_DRY_RUN', 'True')
os.environ.setdefault('MRA_EIS_ALLOW_LIVE_SUBMISSION', 'False')
os.environ.setdefault('MRA_EIS_ENABLE_HTTP_CALLS', 'True')
os.environ.setdefault('MRA_EIS_BASE_URL', 'https://dev-eis-api.mra.mw')
os.environ.setdefault('MRA_EIS_STRICT_PRODUCT_CODES', 'True')

from .settings import *  # noqa: F401,F403

DEBUG = True
IS_PRODUCTION = False

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': BASE_DIR / 'db.test.sqlite3',
    }
}

PASSWORD_HASHERS = ['django.contrib.auth.hashers.MD5PasswordHasher']
EMAIL_BACKEND = 'django.core.mail.backends.locmem.EmailBackend'
