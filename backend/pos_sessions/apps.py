from django.apps import AppConfig


class PosSessionsConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'pos_sessions'
    
    def ready(self):
        """Register signals when app is ready"""
        import pos_sessions.mark_dirty_on_update  # noqa
