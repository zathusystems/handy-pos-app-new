"""
URL configuration for core project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/6.0/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from rest_framework_simplejwt.views import (
    TokenObtainPairView,
    TokenRefreshView,
)
from rest_framework.routers import DefaultRouter

from .health import health_check
from business.views import CustomerViewSet, InvoiceViewSet
from sync_views import sync_to_cloud, sync_status

# Create a separate router for customers and invoices
business_router = DefaultRouter()
business_router.register(r'customers', CustomerViewSet, basename='customer')
business_router.register(r'invoices', InvoiceViewSet, basename='invoice')

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/accounts/', include('accounts.urls')),
    path('accounts/', include('accounts.urls')),  # Also support /accounts/ for backward compatibility
    
    path('api/business/', include('business.urls')),
    path('business/', include('business.urls')),

    path('api/staff/', include('staff.urls')),
    path('staff/', include('staff.urls')),

    path('api/subscription/', include('subscription.urls')),
    path('subscription/', include('subscription.urls')),
    
    path('api/affiliate/', include('affiliate.urls')),
    path('affiliate/', include('affiliate.urls')),

    path('api/inventory/', include('inventory.urls')),
    path('inventory/', include('inventory.urls')),
    
    path('api/digital-menu/', include('digitalmenu.urls')),
    path('digital-menu/', include('digitalmenu.urls')),
    
    path('api/sessions/', include('pos_sessions.urls')),
    path('sessions/', include('pos_sessions.urls')),
    
    path('api/orders/', include('take_orders.urls')),
    path('orders/', include('take_orders.urls')),
    
    path('api/config/', include('system_config.urls')),
    path('config/', include('system_config.urls')),

    path('api/payments/', include('payments.urls')),
    path('payments/', include('payments.urls')),
    
    path('api/', include(business_router.urls)),  # Customers and Invoices at /api/customers/ and /api/invoices/
    
    path('api/health/', health_check),
    path('health/', health_check),
    
    # Standalone Cloud Sync endpoints
    path('api/sync-to-cloud/', sync_to_cloud, name='sync-to-cloud'),
    path('api/sync-status/', sync_status, name='sync-status'),
    
    # JWT auth endpoints
    path('api/auth/token/', TokenObtainPairView.as_view(), name='token_obtain_pair'),
    path('auth/token/', TokenObtainPairView.as_view(), name='token_obtain_pair'),
    
    path('api/auth/token/refresh/', TokenRefreshView.as_view(), name='token_refresh'),
    path('auth/token/refresh/', TokenRefreshView.as_view(), name='token_refresh'),
    
    # Public menu pages - must be last
    path('api/mra-eis/', include('mra_eis.urls')),
    path('mra-eis/', include('mra_eis.urls')),
    
    path('api/mra/', include('mra_eis.urls')),  # Alias for backward compatibility
    path('mra/', include('mra_eis.urls')),  # Alias for backward compatibility
    
    path('', include('digitalmenu.urls')),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
