from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import TakeOrderViewSet, public_order_phone_lookup, public_order_status, self_service_order
from .sync_views import sync_push, sync_pull

router = DefaultRouter()
router.register(r'take-orders', TakeOrderViewSet, basename='take-order')

urlpatterns = [
    path('self-service/', self_service_order, name='self-service-order'),
    path('public-status/<uuid:order_id>/', public_order_status, name='public-order-status'),
    path('public-lookup/', public_order_phone_lookup, name='public-order-phone-lookup'),
    path('sync/push/', sync_push, name='take-order-sync-push'),
    path('sync/pull/', sync_pull, name='take-order-sync-pull'),
    path('', include(router.urls)),
]
