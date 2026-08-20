from django.apps import AppConfig


class InventoryConfig(AppConfig):
    name = 'inventory'
    
    def ready(self):
        import inventory.mark_dirty_on_update
