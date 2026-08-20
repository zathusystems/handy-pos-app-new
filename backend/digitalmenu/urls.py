from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import MenuOptionGroupViewSet, MenuOptionViewSet, MenuViewSet, MenuConfigViewSet
from .views_template import public_menu_view

router = DefaultRouter()
router.register(r'menu', MenuViewSet, basename='menu')
router.register(r'menu-option-groups', MenuOptionGroupViewSet, basename='menu-option-group')
router.register(r'menu-options', MenuOptionViewSet, basename='menu-option')
router.register(r'menu-config', MenuConfigViewSet, basename='menu-config')

urlpatterns = [
    path('', include(router.urls)),
    # Public menu template view
    path('<str:business_slug>/<str:branch_slug>/', public_menu_view, name='public_menu'),
]
