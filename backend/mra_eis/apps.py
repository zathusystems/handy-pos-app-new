"""
MRA EIS App Configuration
"""
from django.apps import AppConfig


class MraEisConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'mra_eis'
    verbose_name = 'MRA EIS Integration'

    def ready(self):
        """Initialize app signals and tasks"""
        import mra_eis.signals  # noqa
