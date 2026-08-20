"""
Importable production settings module.

Use ``core.prod_settings`` as DJANGO_SETTINGS_MODULE on the VPS.
The underlying configuration still comes from ``core.settings`` and is
switched into production mode by environment variables such as
``DEBUG=False`` and ``ENVIRONMENT=production``.
"""

from .settings import *  # noqa: F401,F403
