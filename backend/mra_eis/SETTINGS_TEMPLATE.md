# MRA EIS Settings Template

Add the following to your `backend/core/settings.py`:

```python
import os
from pathlib import Path

# ... existing settings ...

# ============================================================================
# MRA EIS CONFIGURATION
# ============================================================================

# Add to INSTALLED_APPS
INSTALLED_APPS = [
    # ... existing apps ...
    'mra_eis',
]

# MRA EIS API Configuration
MRA_EIS_API_URL = os.getenv(
    'MRA_EIS_API_URL',
    'https://api.mra.gov.mw/eis'  # Production URL
)

MRA_EIS_SANDBOX_MODE = os.getenv(
    'MRA_EIS_SANDBOX_MODE',
    'True'
) == 'True'

MRA_EIS_TIMEOUT = int(os.getenv(
    'MRA_EIS_TIMEOUT',
    '30'
))

# MRA EIS Logging
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'verbose': {
            'format': '{levelname} {asctime} {module} {process:d} {thread:d} {message}',
            'style': '{',
        },
    },
    'handlers': {
        'file': {
            'level': 'INFO',
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': os.path.join(BASE_DIR, 'logs', 'mra_eis.log'),
            'maxBytes': 1024 * 1024 * 10,  # 10MB
            'backupCount': 5,
            'formatter': 'verbose',
        },
        'console': {
            'level': 'DEBUG',
            'class': 'logging.StreamHandler',
            'formatter': 'verbose',
        },
    },
    'loggers': {
        'mra_eis': {
            'handlers': ['file', 'console'],
            'level': 'INFO',
            'propagate': False,
        },
    },
}

# Create logs directory if it doesn't exist
LOGS_DIR = os.path.join(BASE_DIR, 'logs')
os.makedirs(LOGS_DIR, exist_ok=True)
```

## Environment Variables

Create a `.env` file in your project root:

```bash
# MRA EIS Configuration
MRA_EIS_API_URL=https://api.mra.gov.mw/eis
MRA_EIS_SANDBOX_MODE=True
MRA_EIS_TIMEOUT=30

# For production, use:
# MRA_EIS_API_URL=https://api.mra.gov.mw/eis
# MRA_EIS_SANDBOX_MODE=False
# MRA_EIS_TIMEOUT=30
```

## Celery Configuration (Optional)

If using Celery for periodic tasks:

```python
# In settings.py

from celery.schedules import crontab

CELERY_BEAT_SCHEDULE = {
    'sync-mra-configurations': {
        'task': 'mra_eis.tasks.sync_mra_configurations',
        'schedule': crontab(hour=2, minute=0),  # Daily at 2 AM
    },
    'process-mra-retries': {
        'task': 'mra_eis.tasks.process_mra_retries',
        'schedule': crontab(minute='*/5'),  # Every 5 minutes
    },
    'refresh-mra-tokens': {
        'task': 'mra_eis.tasks.refresh_mra_tokens',
        'schedule': crontab(hour='*/6'),  # Every 6 hours
    },
}
```

Create `mra_eis/tasks.py`:

```python
from celery import shared_task
from django.utils import timezone
from business.models import Business
from .services import ConfigurationService, RetryService, TerminalService
from .models import Terminal

@shared_task
def sync_mra_configurations():
    """Sync MRA configurations for all active businesses"""
    for business in Business.objects.filter(is_active=True):
        try:
            ConfigurationService.fetch_and_store_configuration(business)
        except Exception as e:
            print(f"Failed to sync config for {business.name}: {e}")

@shared_task
def process_mra_retries():
    """Process pending retries"""
    try:
        RetryService.process_retry_queue()
    except Exception as e:
        print(f"Failed to process retries: {e}")

@shared_task
def refresh_mra_tokens():
    """Refresh MRA tokens for all active terminals"""
    for terminal in Terminal.objects.filter(status='active'):
        try:
            TerminalService.refresh_token(terminal)
        except Exception as e:
            print(f"Failed to refresh token for {terminal.terminal_id}: {e}")
```

## Cron Configuration (Alternative)

If not using Celery, add to crontab:

```bash
# Edit crontab
crontab -e

# Add these lines:

# Sync MRA configuration daily at 2 AM
0 2 * * * cd /path/to/project && python manage.py sync_mra_config

# Process retry queue every 5 minutes
*/5 * * * * cd /path/to/project && python manage.py process_mra_retries

# Refresh tokens every 6 hours
0 */6 * * * cd /path/to/project && python manage.py refresh_mra_tokens
```

Create `mra_eis/management/commands/refresh_mra_tokens.py`:

```python
from django.core.management.base import BaseCommand
from mra_eis.models import Terminal
from mra_eis.services import TerminalService

class Command(BaseCommand):
    help = 'Refresh MRA tokens for all active terminals'

    def handle(self, *args, **options):
        terminals = Terminal.objects.filter(status='active')
        
        for terminal in terminals:
            try:
                self.stdout.write(f"Refreshing token for {terminal.terminal_id}...")
                TerminalService.refresh_token(terminal)
                self.stdout.write(
                    self.style.SUCCESS(f"✓ Token refreshed for {terminal.terminal_id}")
                )
            except Exception as e:
                self.stdout.write(
                    self.style.ERROR(f"✗ Failed to refresh token: {e}")
                )
```

## Monitoring & Alerts

Add monitoring configuration:

```python
# In settings.py

# Email alerts for critical errors
ADMINS = [
    ('Admin Name', 'admin@example.com'),
]

# Alert on MRA errors
MRA_ERROR_ALERT_THRESHOLD = 5  # Alert if 5+ errors in 1 hour

# Alert on offline queue size
MRA_OFFLINE_QUEUE_ALERT_THRESHOLD = 100  # Alert if queue > 100

# Alert on token expiration
MRA_TOKEN_EXPIRY_WARNING_HOURS = 24  # Warn 24 hours before expiry
```

## Security Settings

For production:

```python
# In settings.py

# Encrypt sensitive data
INSTALLED_APPS = [
    # ...
    'django_cryptography',
]

# Use encrypted fields for MRA credentials
MRA_ENCRYPT_CREDENTIALS = True

# Require HTTPS for MRA API calls
MRA_REQUIRE_HTTPS = True

# Rate limiting for MRA API
MRA_RATE_LIMIT_REQUESTS = 100
MRA_RATE_LIMIT_PERIOD = 3600  # per hour

# Disable debug mode
DEBUG = False

# Set allowed hosts
ALLOWED_HOSTS = ['yourdomain.com', 'www.yourdomain.com']

# HTTPS settings
SECURE_SSL_REDIRECT = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
```

## Database Backups

Ensure regular backups of MRA data:

```bash
# Daily backup script
#!/bin/bash

BACKUP_DIR="/path/to/backups"
DB_NAME="handy_pos"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Backup database
python manage.py dumpdata mra_eis > $BACKUP_DIR/mra_eis_$TIMESTAMP.json

# Keep only last 30 days
find $BACKUP_DIR -name "mra_eis_*.json" -mtime +30 -delete

echo "Backup completed: $BACKUP_DIR/mra_eis_$TIMESTAMP.json"
```

Add to crontab:

```bash
# Daily backup at 3 AM
0 3 * * * /path/to/backup_script.sh
```

## Testing Configuration

For testing:

```python
# In settings.py or test settings

if 'test' in sys.argv:
    # Use test database
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': ':memory:',
        }
    }
    
    # Disable MRA API calls in tests
    MRA_EIS_SANDBOX_MODE = True
    MRA_EIS_API_URL = 'http://localhost:8000/mock-mra'
    
    # Disable email
    EMAIL_BACKEND = 'django.core.mail.backends.locmem.EmailBackend'
```

## Development Configuration

For development:

```python
# In settings.py

if DEBUG:
    # Allow all origins for development
    CORS_ALLOW_ALL_ORIGINS = True
    
    # Use sandbox MRA
    MRA_EIS_SANDBOX_MODE = True
    
    # Verbose logging
    LOGGING['loggers']['mra_eis']['level'] = 'DEBUG'
    
    # Disable HTTPS requirement
    SECURE_SSL_REDIRECT = False
    SESSION_COOKIE_SECURE = False
    CSRF_COOKIE_SECURE = False
```

## Deployment Checklist

Before deploying to production:

- [ ] Update `MRA_EIS_API_URL` to production endpoint
- [ ] Set `MRA_EIS_SANDBOX_MODE = False`
- [ ] Configure encryption for credentials
- [ ] Setup periodic tasks (Celery or cron)
- [ ] Configure email alerts
- [ ] Setup monitoring
- [ ] Configure backups
- [ ] Test all flows
- [ ] Verify audit logs
- [ ] Get MRA certification
- [ ] Setup error tracking (Sentry, etc.)
- [ ] Configure rate limiting
- [ ] Setup HTTPS
- [ ] Configure firewall rules
- [ ] Test offline mode
- [ ] Verify token refresh

## Troubleshooting

### Settings not loading
```python
# Check settings are imported
from django.conf import settings
print(settings.MRA_EIS_API_URL)
```

### Logging not working
```bash
# Check logs directory exists
mkdir -p logs

# Check permissions
chmod 755 logs
```

### Periodic tasks not running
```bash
# Check cron is running
sudo service cron status

# Check crontab
crontab -l

# Check logs
tail -f /var/log/syslog | grep CRON
```

### Database issues
```bash
# Run migrations
python manage.py migrate mra_eis

# Check migration status
python manage.py showmigrations mra_eis
```
