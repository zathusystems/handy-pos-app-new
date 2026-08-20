from django.apps import AppConfig


class StaffConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'staff'
    
    def ready(self):
        """Register signals when app is ready"""
        import staff.mark_dirty_on_update  # noqa
