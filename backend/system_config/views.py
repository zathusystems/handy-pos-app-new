from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from .models import (
    SystemConfig, FeaturePricingConfig, PaymentGatewayConfig,
    PaymentMethodConfig, BankTransferConfig, MobileMoneyConfig
)
from .serializers import (
    SystemConfigSerializer,
    FeaturePricingConfigSerializer, PaymentGatewayConfigSerializer,
    PaymentMethodConfigSerializer, BankTransferConfigSerializer,
    MobileMoneyConfigSerializer
)


class SystemConfigViewSet(viewsets.ReadOnlyModelViewSet):
    """
    API endpoint for system configuration.
    GET only - configuration is managed via admin panel.
    """
    queryset = SystemConfig.objects.all()
    serializer_class = SystemConfigSerializer
    permission_classes = [permissions.AllowAny]

    @action(detail=False, methods=['get'])
    def current(self, request):
        """Get current system configuration"""
        config = SystemConfig.get_config()
        serializer = self.get_serializer(config)
        return Response(serializer.data)

class FeaturePricingConfigViewSet(viewsets.ReadOnlyModelViewSet):
    """
    API endpoint for feature pricing configuration.
    Returns all features (active and inactive) for frontend to display.
    """
    queryset = FeaturePricingConfig.objects.all().order_by('feature')
    serializer_class = FeaturePricingConfigSerializer
    permission_classes = [permissions.AllowAny]
    filterset_fields = ['is_premium', 'is_active']
    search_fields = ['feature']
    pagination_class = None  # Disable pagination to return all features at once

    @action(detail=False, methods=['get'])
    def all_features(self, request):
        """Get all feature pricing (active and inactive)"""
        features = FeaturePricingConfig.objects.all().order_by('feature')
        serializer = self.get_serializer(features, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def active_only(self, request):
        """Get only active feature pricing"""
        features = FeaturePricingConfig.objects.filter(is_active=True).order_by('feature')
        serializer = self.get_serializer(features, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def premium_only(self, request):
        """Get only premium features"""
        features = FeaturePricingConfig.objects.filter(is_premium=True).order_by('feature')
        serializer = self.get_serializer(features, many=True)
        return Response(serializer.data)


class PaymentGatewayConfigViewSet(viewsets.ReadOnlyModelViewSet):
    """
    API endpoint for payment gateway configuration.
    """
    queryset = PaymentGatewayConfig.objects.all()
    serializer_class = PaymentGatewayConfigSerializer
    permission_classes = [permissions.AllowAny]
    filterset_fields = ['is_enabled']

    @action(detail=False, methods=['get'])
    def enabled_gateways(self, request):
        """Get only enabled payment gateways"""
        gateways = PaymentGatewayConfig.objects.filter(is_enabled=True)
        serializer = self.get_serializer(gateways, many=True)
        return Response(serializer.data)


class PaymentMethodConfigViewSet(viewsets.ReadOnlyModelViewSet):
    """
    API endpoint for payment method configuration per currency.
    """
    queryset = PaymentMethodConfig.objects.filter(is_enabled=True)
    serializer_class = PaymentMethodConfigSerializer
    permission_classes = [permissions.AllowAny]
    filterset_fields = ['currency', 'is_enabled']
    ordering_fields = ['display_order']
    ordering = ['currency', 'display_order']

    @action(detail=False, methods=['get'])
    def by_currency(self, request):
        """Get payment methods for a specific currency"""
        currency = request.query_params.get('currency')
        if not currency:
            return Response(
                {'detail': 'Currency parameter required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        methods = PaymentMethodConfig.objects.filter(currency=currency, is_enabled=True)
        serializer = self.get_serializer(methods, many=True)
        return Response(serializer.data)


class BankTransferConfigViewSet(viewsets.ReadOnlyModelViewSet):
    """
    API endpoint for bank transfer configuration per currency.
    """
    queryset = BankTransferConfig.objects.all()
    serializer_class = BankTransferConfigSerializer
    permission_classes = [permissions.AllowAny]
    filterset_fields = ['currency']

    @action(detail=False, methods=['get'])
    def by_currency(self, request):
        """Get bank transfer details for a specific currency"""
        currency = request.query_params.get('currency')
        if not currency:
            return Response(
                {'detail': 'Currency parameter required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        try:
            bank = BankTransferConfig.objects.get(currency=currency)
            serializer = self.get_serializer(bank)
            return Response(serializer.data)
        except BankTransferConfig.DoesNotExist:
            return Response(
                {'detail': 'Bank transfer configuration not found for this currency'},
                status=status.HTTP_404_NOT_FOUND
            )


class MobileMoneyConfigViewSet(viewsets.ReadOnlyModelViewSet):
    """
    API endpoint for mobile money configuration (MWK).
    """
    queryset = MobileMoneyConfig.objects.filter(is_enabled=True)
    serializer_class = MobileMoneyConfigSerializer
    permission_classes = [permissions.AllowAny]
    filterset_fields = ['is_enabled']
    ordering_fields = ['display_order']
    ordering = ['display_order']
