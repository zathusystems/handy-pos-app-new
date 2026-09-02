"""
MRA EIS API Views - REST endpoints for MRA integration
"""
from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django.conf import settings
from django.shortcuts import get_object_or_404
from django.db.models import Q
from .models import (
    Terminal, TerminalActivationCode, MRAConfiguration, MRAProductMapping,
    MRAInvoice, OfflineInvoiceQueue, Receipt, InvoiceAuditLog,
    TerminalAuditLog, MRAAPIError
)
from .serializers import (
    TerminalSerializer, TerminalDetailSerializer, TerminalActivationSerializer,
    MRAConfigurationSerializer, MRAProductMappingSerializer,
    MRAProductMappingCreateSerializer, MRAInvoiceSerializer,
    MRAInvoiceCreateSerializer, OfflineInvoiceQueueSerializer,
    ReceiptSerializer, InvoiceAuditLogSerializer, TerminalAuditLogSerializer,
    MRAAPIErrorSerializer, TerminalStatusSerializer, SyncStatusSerializer
)
from .services import (
    TerminalService, ConfigurationService, ProductMappingService,
    InvoiceService, ReceiptService, RetryService, POSOrderSubmissionService,
    MRAIntegrationError, is_business_eis_enabled,
)
from rest_framework.views import APIView
from business.access import get_accessible_business_queryset


def _get_accessible_business_queryset(user):
    """
    Return businesses user can operate on for MRA actions.
    Supports owners, superusers, and assigned active Admin staff.
    """
    return get_accessible_business_queryset(user, admin_staff_only=True)


def _eis_disabled_response():
    """Return the consistent response for a business that has not opted in."""
    return Response(
        {
            'error': 'MRA EIS is not enabled for this business. Enable it in Settings before using EIS features.',
            'code': 'EIS_DISABLED',
        },
        status=status.HTTP_403_FORBIDDEN,
    )


def _normalize_mra_tax_type(value):
    normalized = str(value or '').strip().lower()
    if normalized in {'zero', 'zero_rated', 'zero-rated', 'vat_zero', 'vat-zero', '0'}:
        return 'zero'
    if normalized in {'exempt', 'vat_exempt', 'vat-exempt'}:
        return 'exempt'
    return 'standard'


def _normalize_mra_tax_rate(value, tax_type):
    if value is None or value == '':
        return 0.0 if tax_type in {'zero', 'exempt'} else 16.5

    try:
        if isinstance(value, str):
            value = value.replace('%', '').strip()
        parsed = float(value)
        if parsed < 0:
            return 0.0
        return parsed
    except (TypeError, ValueError):
        return 0.0 if tax_type in {'zero', 'exempt'} else 16.5


def _normalize_product_code_item(item):
    return ConfigurationService._normalize_product_catalog_item(item)


def _extract_product_codes_from_config(config_data):
    return ConfigurationService.extract_product_catalog(config_data)


class TerminalViewSet(viewsets.ModelViewSet):
    """
    ViewSet for terminal management.
    Handles activation, status, and configuration.
    """
    permission_classes = [IsAuthenticated]
    serializer_class = TerminalSerializer

    def get_queryset(self):
        """Filter terminals by business"""
        business_ids = _get_accessible_business_queryset(self.request.user).values_list('id', flat=True)
        queryset = Terminal.objects.filter(
            business_id__in=business_ids
        ).select_related('business', 'branch')

        business_id = self.request.query_params.get('business_id')
        branch_id = self.request.query_params.get('branch_id')
        device_serial = self.request.query_params.get('device_serial')
        if business_id:
            queryset = queryset.filter(business_id=business_id)
        if branch_id:
            queryset = queryset.filter(branch_id=branch_id)
        if device_serial:
            queryset = queryset.filter(device_serial__iexact=device_serial.strip())
        return queryset

    def get_serializer_class(self):
        if self.action == 'retrieve':
            return TerminalDetailSerializer
        elif self.action == 'activate':
            return TerminalActivationSerializer
        return TerminalSerializer

    @action(detail=False, methods=['post'])
    def activate(self, request):
        """Activate a new terminal using TAC"""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            # Get business and branch from request
            business_id = request.query_params.get('business_id')
            branch_id = request.query_params.get('branch_id')
            if not business_id or not branch_id:
                return Response(
                    {'error': 'business_id and branch_id are required.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            from business.models import Business, Branch
            accessible_businesses = _get_accessible_business_queryset(request.user)
            business = get_object_or_404(accessible_businesses, id=business_id)
            branch = get_object_or_404(Branch, id=branch_id, business=business)

            if not is_business_eis_enabled(business):
                return _eis_disabled_response()

            terminal = TerminalService.activate_terminal(
                business=business,
                branch=branch,
                tac_code=serializer.validated_data['tac_code'],
                pos_name=serializer.validated_data['pos_name'],
                pos_version=serializer.validated_data['pos_version'],
                os_type=serializer.validated_data['os_type'],
                device_serial=serializer.validated_data['device_serial'],
                mac_address=serializer.validated_data.get('mac_address', '')
            )

            return Response(
                TerminalDetailSerializer(terminal).data,
                status=status.HTTP_201_CREATED
            )
        except (ValueError, MRAIntegrationError) as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )

    @action(detail=True, methods=['post'])
    def refresh_token(self, request, pk=None):
        """Refresh MRA authentication token"""
        terminal = self.get_object()
        if not is_business_eis_enabled(terminal.business):
            return _eis_disabled_response()
        try:
            TerminalService.refresh_token(terminal)
            return Response(
                TerminalDetailSerializer(terminal).data,
                status=status.HTTP_200_OK
            )
        except Exception as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )

    @action(detail=True, methods=['get'])
    def status(self, request, pk=None):
        """Get terminal status"""
        terminal = self.get_object()

        pending_offline = OfflineInvoiceQueue.objects.filter(
            terminal=terminal,
            status='queued'
        ).count()

        serializer = TerminalStatusSerializer({
            'terminal_id': terminal.terminal_id,
            'mra_terminal_id': terminal.mra_terminal_id or '',
            'device_serial': terminal.device_serial or '',
            'terminal_position': terminal.terminal_position,
            'status': terminal.status,
            'is_online': terminal.is_online,
            'blocking_status': TerminalService.get_cached_blocking_status(terminal),
            'online_invoice_counter': terminal.online_invoice_counter,
            'offline_invoice_counter': terminal.offline_invoice_counter,
            'pending_offline_invoices': pending_offline,
            'token_expires_at': terminal.token_expires_at,
            'last_sync_at': terminal.last_sync_at,
        })

        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def pull_approved_products(self, request, pk=None):
        """Pull MRA portal-approved site products into this branch's POS inventory."""
        terminal = self.get_object()
        if not is_business_eis_enabled(terminal.business):
            return _eis_disabled_response()

        refresh_from_mra = request.data.get('refreshFromMra', request.data.get('refresh_from_mra', True))
        if isinstance(refresh_from_mra, str):
            refresh_from_mra = refresh_from_mra.strip().lower() not in {'false', '0', 'no', 'off'}

        try:
            result = ProductMappingService.pull_approved_products_to_inventory(
                business=terminal.business,
                terminal=terminal,
                user=request.user,
                refresh_from_mra=bool(refresh_from_mra),
            )
            return Response(result, status=status.HTTP_200_OK)
        except (ValueError, MRAIntegrationError) as exc:
            return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['get'])
    def warehouse_inventory(self, request, pk=None):
        """Return the official MRA warehouse stock available for transfer."""
        terminal = self.get_object()
        if not is_business_eis_enabled(terminal.business):
            return _eis_disabled_response()

        try:
            page_size = min(max(int(request.query_params.get('page_size', 200)), 1), 500)
            max_pages = min(max(int(request.query_params.get('max_pages', 25)), 1), 25)
            result = ProductMappingService.fetch_warehouse_inventory(
                business=terminal.business,
                terminal=terminal,
                page_size=page_size,
                max_pages=max_pages,
            )
            return Response(result, status=status.HTTP_200_OK)
        except (TypeError, ValueError, MRAIntegrationError) as exc:
            return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['post'])
    def transfer_inventory(self, request, pk=None):
        """Transfer warehouse stock to a local branch through MRA EIS."""
        terminal = self.get_object()
        if not is_business_eis_enabled(terminal.business):
            return _eis_disabled_response()

        from business.models import Branch

        to_branch_id = request.data.get('toBranchId') or request.data.get('to_branch_id')
        to_branch = None
        if to_branch_id:
            to_branch = get_object_or_404(
                Branch,
                id=to_branch_id,
                business=terminal.business,
                is_active=True,
            )
        from_warehouse = request.data.get(
            'fromWarehouseToSite', request.data.get('from_warehouse_to_site', True)
        )
        if isinstance(from_warehouse, str):
            from_warehouse = from_warehouse.strip().lower() not in {'false', '0', 'no', 'off'}

        try:
            result = ProductMappingService.transfer_inventory(
                business=terminal.business,
                terminal=terminal,
                items=request.data.get('items', []),
                to_branch=to_branch,
                to_site_id=request.data.get('toSiteId') or request.data.get('to_site_id') or '',
                from_site_id=request.data.get('fromSiteId') or request.data.get('from_site_id') or '',
                from_warehouse_to_site=bool(from_warehouse),
            )
            return Response(result, status=status.HTTP_200_OK)
        except (ValueError, MRAIntegrationError) as exc:
            return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['post'])
    def reconcile_inventory(self, request, pk=None):
        """Compare local approved inventory with official EIS warehouse stock."""
        terminal = self.get_object()
        if not is_business_eis_enabled(terminal.business):
            return _eis_disabled_response()

        branch = terminal.branch
        branch_id = request.data.get('branchId') or request.data.get('branch_id')
        if branch_id:
            from business.models import Branch

            branch = get_object_or_404(
                Branch,
                id=branch_id,
                business=terminal.business,
                is_active=True,
            )

        try:
            result = ProductMappingService.reconcile_inventory_with_eis(
                business=terminal.business,
                terminal=terminal,
                branch=branch,
            )
            return Response(result, status=status.HTTP_200_OK)
        except (ValueError, MRAIntegrationError) as exc:
            return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['post'])
    def check_blocking_status(self, request, pk=None):
        """Refresh the terminal's block decision from MRA."""
        terminal = self.get_object()
        if not is_business_eis_enabled(terminal.business):
            return _eis_disabled_response()

        try:
            result = TerminalService.get_terminal_blocking_message(terminal)
            terminal.refresh_from_db()
            return Response(
                {
                    **result,
                    'status': terminal.status,
                    'blocking_status': TerminalService.get_cached_blocking_status(terminal),
                },
                status=status.HTTP_200_OK,
            )
        except MRAIntegrationError as exc:
            return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['post'])
    def check_unblock_status(self, request, pk=None):
        """Ask MRA whether a suspended terminal has been released."""
        terminal = self.get_object()
        if not is_business_eis_enabled(terminal.business):
            return _eis_disabled_response()

        try:
            result = TerminalService.check_terminal_unblock_status(terminal)
            terminal.refresh_from_db()
            return Response(
                {
                    **result,
                    'status': terminal.status,
                    'blocking_status': TerminalService.get_cached_blocking_status(terminal),
                },
                status=status.HTTP_200_OK,
            )
        except MRAIntegrationError as exc:
            return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['post'])
    def update_online_status(self, request, pk=None):
        """Update terminal online/offline status"""
        terminal = self.get_object()
        is_online = request.data.get('is_online', True)

        TerminalService.update_online_status(terminal, is_online)

        return Response(
            TerminalDetailSerializer(terminal).data,
            status=status.HTTP_200_OK
        )

    @action(detail=True, methods=['get'])
    def audit_logs(self, request, pk=None):
        """Get terminal audit logs"""
        terminal = self.get_object()
        logs = TerminalAuditLog.objects.filter(terminal=terminal).order_by('-created_at')[:100]

        serializer = TerminalAuditLogSerializer(logs, many=True)
        return Response(serializer.data)


class MRAConfigurationViewSet(viewsets.ReadOnlyModelViewSet):
    """
    ViewSet for MRA configurations.
    Read-only - configurations are fetched from MRA.
    """
    permission_classes = [IsAuthenticated]
    serializer_class = MRAConfigurationSerializer

    def get_queryset(self):
        """Filter configurations by business"""
        business_ids = _get_accessible_business_queryset(self.request.user).values_list('id', flat=True)
        queryset = MRAConfiguration.objects.filter(
            business_id__in=business_ids,
            is_active=True
        )

        business_id = self.request.query_params.get('business_id')
        if business_id:
            queryset = queryset.filter(business_id=business_id)

        return queryset.order_by('-effective_from')

    @action(detail=False, methods=['post'])
    def sync_from_mra(self, request):
        """Fetch and sync configurations from MRA"""
        business_id = request.query_params.get('business_id')
        accessible_businesses = _get_accessible_business_queryset(request.user)
        business = get_object_or_404(accessible_businesses, id=business_id)

        if not is_business_eis_enabled(business):
            return _eis_disabled_response()

        config_types = request.data.get('config_types', None)
        terminal_id = request.query_params.get('terminal_id')
        terminal = None
        if terminal_id:
            terminal = get_object_or_404(
                Terminal,
                id=terminal_id,
                business=business,
            )

        try:
            sync_log = ConfigurationService.fetch_and_store_configuration(
                business=business,
                config_types=config_types,
                terminal=terminal,
            )

            return Response(
                {
                    'status': sync_log.status,
                    'config_types': sync_log.config_types,
                    'completed_at': sync_log.completed_at,
                    'stored_configurations': getattr(sync_log, 'stored_configurations', []),
                },
                status=status.HTTP_200_OK
            )
        except Exception as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )


class MRAProductMappingViewSet(viewsets.ModelViewSet):
    """
    ViewSet for product to MRA code mappings.
    """
    permission_classes = [IsAuthenticated]
    serializer_class = MRAProductMappingSerializer

    def get_queryset(self):
        """Filter mappings by business"""
        business_ids = _get_accessible_business_queryset(self.request.user).values_list('id', flat=True)
        return MRAProductMapping.objects.filter(
            business_id__in=business_ids,
            is_active=True
        )

    def get_serializer_class(self):
        if self.action == 'create':
            return MRAProductMappingCreateSerializer
        return MRAProductMappingSerializer

    def create(self, request, *args, **kwargs):
        """Create a product mapping"""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        business_id = request.query_params.get('business_id')
        accessible_businesses = _get_accessible_business_queryset(request.user)
        business = get_object_or_404(accessible_businesses, id=business_id)

        try:
            mapping = ProductMappingService.create_product_mapping(
                business=business,
                **serializer.validated_data
            )

            return Response(
                MRAProductMappingSerializer(mapping).data,
                status=status.HTTP_201_CREATED
            )
        except Exception as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )


class MRAInvoiceViewSet(viewsets.ModelViewSet):
    """
    ViewSet for MRA invoices.
    Handles creation, submission, and offline queuing.
    """
    permission_classes = [IsAuthenticated]
    serializer_class = MRAInvoiceSerializer

    def get_queryset(self):
        """Filter invoices by business"""
        business_ids = _get_accessible_business_queryset(self.request.user).values_list('id', flat=True)
        return MRAInvoice.objects.filter(
            business_id__in=business_ids
        ).select_related('terminal', 'branch')

    def get_serializer_class(self):
        if self.action == 'create':
            return MRAInvoiceCreateSerializer
        return MRAInvoiceSerializer

    def create(self, request, *args, **kwargs):
        """Create an invoice"""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        terminal_id = request.query_params.get('terminal_id')
        business_ids = _get_accessible_business_queryset(request.user).values_list('id', flat=True)
        terminal = get_object_or_404(Terminal, id=terminal_id, business_id__in=business_ids)

        if not is_business_eis_enabled(terminal.business):
            return _eis_disabled_response()

        try:
            invoice = InvoiceService.create_invoice(
                terminal=terminal,
                seller_tin=serializer.validated_data['seller_tin'],
                seller_name=serializer.validated_data['seller_name'],
                items=serializer.validated_data['items'],
                buyer_tin=serializer.validated_data.get('buyer_tin'),
                buyer_name=serializer.validated_data.get('buyer_name'),
                is_online=serializer.validated_data.get('is_online', True)
            )

            return Response(
                MRAInvoiceSerializer(invoice).data,
                status=status.HTTP_201_CREATED
            )
        except Exception as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )

    @action(detail=True, methods=['post'])
    def submit(self, request, pk=None):
        """Submit invoice to MRA"""
        invoice = self.get_object()

        if not is_business_eis_enabled(invoice.business):
            return _eis_disabled_response()

        try:
            InvoiceService.submit_invoice(invoice)
            return Response(
                MRAInvoiceSerializer(invoice).data,
                status=status.HTTP_200_OK
            )
        except Exception as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )

    @action(detail=True, methods=['post'])
    def queue_offline(self, request, pk=None):
        """Queue invoice for offline sync"""
        invoice = self.get_object()

        if not is_business_eis_enabled(invoice.business):
            return _eis_disabled_response()

        try:
            queue_entry = InvoiceService.queue_offline_invoice(invoice)
            return Response(
                OfflineInvoiceQueueSerializer(queue_entry).data,
                status=status.HTTP_200_OK
            )
        except Exception as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )

    @action(detail=False, methods=['post'])
    def sync_offline(self, request):
        """Sync offline invoices for a terminal"""
        terminal_id = request.query_params.get('terminal_id')
        business_ids = _get_accessible_business_queryset(request.user).values_list('id', flat=True)
        terminal = get_object_or_404(Terminal, id=terminal_id, business_id__in=business_ids)

        if not is_business_eis_enabled(terminal.business):
            return _eis_disabled_response()

        try:
            result = InvoiceService.sync_offline_invoices(terminal)

            pending = OfflineInvoiceQueue.objects.filter(
                terminal=terminal,
                status='queued'
            ).count()

            serializer = SyncStatusSerializer({
                'synced_count': result['synced'],
                'failed_count': result['failed'],
                'pending_count': pending,
                'last_sync_at': terminal.last_sync_at,
            })

            return Response(serializer.data, status=status.HTTP_200_OK)
        except Exception as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )

    @action(detail=True, methods=['get'])
    def audit_logs(self, request, pk=None):
        """Get invoice audit logs"""
        invoice = self.get_object()
        logs = InvoiceAuditLog.objects.filter(
            mra_invoice=invoice
        ).order_by('-created_at')

        serializer = InvoiceAuditLogSerializer(logs, many=True)
        return Response(serializer.data)


class ReceiptViewSet(viewsets.ReadOnlyModelViewSet):
    """
    ViewSet for receipts.
    """
    permission_classes = [IsAuthenticated]
    serializer_class = ReceiptSerializer

    def get_queryset(self):
        """Filter receipts by business"""
        business_ids = _get_accessible_business_queryset(self.request.user).values_list('id', flat=True)
        return Receipt.objects.filter(
            mra_invoice__business_id__in=business_ids
        ).select_related('mra_invoice')

    @action(detail=False, methods=['post'])
    def generate(self, request):
        """Generate receipt for an invoice"""
        invoice_id = request.query_params.get('invoice_id')
        business_ids = _get_accessible_business_queryset(request.user).values_list('id', flat=True)
        invoice = get_object_or_404(
            MRAInvoice,
            id=invoice_id,
            business_id__in=business_ids,
        )

        if not is_business_eis_enabled(invoice.business):
            return _eis_disabled_response()

        try:
            receipt = ReceiptService.generate_receipt(invoice)
            return Response(
                ReceiptSerializer(receipt).data,
                status=status.HTTP_201_CREATED
            )
        except Exception as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )


class OfflineInvoiceQueueViewSet(viewsets.ReadOnlyModelViewSet):
    """
    ViewSet for offline invoice queue.
    """
    permission_classes = [IsAuthenticated]
    serializer_class = OfflineInvoiceQueueSerializer

    def get_queryset(self):
        """Filter queue by business"""
        business_ids = _get_accessible_business_queryset(self.request.user).values_list('id', flat=True)
        return OfflineInvoiceQueue.objects.filter(
            terminal__business_id__in=business_ids
        ).select_related('terminal', 'mra_invoice')

    @action(detail=False, methods=['get'])
    def pending(self, request):
        """Get pending offline invoices for a terminal"""
        terminal_id = request.query_params.get('terminal_id')
        business_ids = _get_accessible_business_queryset(request.user).values_list('id', flat=True)
        terminal = get_object_or_404(Terminal, id=terminal_id, business_id__in=business_ids)

        queue = OfflineInvoiceQueue.objects.filter(
            terminal=terminal,
            status__in=['queued', 'failed']
        ).order_by('queue_position')

        serializer = self.get_serializer(queue, many=True)
        return Response(serializer.data)


class MRAAPIErrorViewSet(viewsets.ReadOnlyModelViewSet):
    """
    ViewSet for API errors.
    """
    permission_classes = [IsAuthenticated]
    serializer_class = MRAAPIErrorSerializer

    def get_queryset(self):
        """Filter errors by business"""
        business_ids = _get_accessible_business_queryset(self.request.user).values_list('id', flat=True)
        return MRAAPIError.objects.filter(
            terminal__business_id__in=business_ids
        ).select_related('terminal')

    @action(detail=False, methods=['get'])
    def unresolved(self, request):
        """Get unresolved errors"""
        errors = self.get_queryset().filter(is_resolved=False).order_by('-created_at')[:50]
        serializer = self.get_serializer(errors, many=True)
        return Response(serializer.data)


class MRAProductCodesView(APIView):
    """
    API endpoint for fetching available MRA product codes.
    This is used by the product mapping form to show available MRA products.
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        """
        Get available MRA product codes.
        
        Returns a list of MRA-approved product codes that can be used for mapping.
        This data is typically fetched from MRA or stored in a configuration.
        """
        include_meta = str(request.query_params.get('include_meta', '')).lower() in {'1', 'true', 'yes'}
        search_query = request.query_params.get('search', '').lower().strip()
        business_id = request.query_params.get('business_id')
        accessible_businesses = _get_accessible_business_queryset(request.user)

        business = None
        if business_id:
            business = get_object_or_404(accessible_businesses, id=business_id)
        else:
            business = accessible_businesses.first()

        catalog_source = 'fallback_catalog'
        config_version = None
        mra_products = []

        # Primary source: active synced MRA product code configuration for the business.
        if business:
            extracted_products, product_config = ConfigurationService.get_product_catalog(business)
            if extracted_products:
                mra_products = [
                    {
                        key: value
                        for key, value in product.items()
                        if not key.startswith('_')
                    }
                    for product in extracted_products
                ]
                catalog_source = 'mra_configuration'
                config_version = product_config.config_version if product_config else None

        # Strict catalog enforcement applies only after a business opts into
        # EIS. Older/non-EIS businesses may continue using ordinary inventory
        # and should never be blocked by MRA configuration availability.
        strict_product_codes = bool(
            business
            and is_business_eis_enabled(business)
            and getattr(settings, 'MRA_EIS_STRICT_PRODUCT_CODES', False)
        )
        if strict_product_codes and not mra_products:
            message = (
                'No active MRA product code configuration found. '
                'Run configuration sync before creating or updating MRA mappings.'
            )
            if include_meta:
                return Response(
                    {
                        'results': [],
                        'count': 0,
                        'source': 'strict_mode',
                        'config_version': config_version,
                        'business_id': str(business.id) if business else None,
                        'error': message,
                    },
                    status=status.HTTP_503_SERVICE_UNAVAILABLE
                )

            return Response(
                {
                    'error': message,
                    'source': 'strict_mode',
                },
                status=status.HTTP_503_SERVICE_UNAVAILABLE
            )

        # Fallback source: local static catalog so mapping can continue offline.
        fallback_products = [
            # BEVERAGES
            {
                'code': 'BEVERAGE-001',
                'name': 'Soft Drink',
                'category': 'Beverages',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            {
                'code': 'BEVERAGE-002',
                'name': 'Juice',
                'category': 'Beverages',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            {
                'code': 'BEVERAGE-003',
                'name': 'Water',
                'category': 'Beverages',
                'default_tax_type': 'zero',
                'default_tax_rate': 0,
            },
            {
                'code': 'BEVERAGE-004',
                'name': 'Alcoholic Beverage',
                'category': 'Beverages',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            {
                'code': 'BEVERAGE-005',
                'name': 'Coffee',
                'category': 'Beverages',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            {
                'code': 'BEVERAGE-006',
                'name': 'Tea',
                'category': 'Beverages',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            
            # FOOD
            {
                'code': 'FOOD-001',
                'name': 'Bread',
                'category': 'Food',
                'default_tax_type': 'zero',
                'default_tax_rate': 0,
            },
            {
                'code': 'FOOD-002',
                'name': 'Milk',
                'category': 'Food',
                'default_tax_type': 'zero',
                'default_tax_rate': 0,
            },
            {
                'code': 'FOOD-003',
                'name': 'Meat',
                'category': 'Food',
                'default_tax_type': 'zero',
                'default_tax_rate': 0,
            },
            {
                'code': 'FOOD-004',
                'name': 'Vegetables',
                'category': 'Food',
                'default_tax_type': 'zero',
                'default_tax_rate': 0,
            },
            {
                'code': 'FOOD-005',
                'name': 'Fruits',
                'category': 'Food',
                'default_tax_type': 'zero',
                'default_tax_rate': 0,
            },
            {
                'code': 'FOOD-006',
                'name': 'Prepared Meal',
                'category': 'Food',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            {
                'code': 'FOOD-007',
                'name': 'Snacks',
                'category': 'Food',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            
            # PHARMACY
            {
                'code': 'PHARMA-001',
                'name': 'Medicine',
                'category': 'Pharmacy',
                'default_tax_type': 'zero',
                'default_tax_rate': 0,
            },
            {
                'code': 'PHARMA-002',
                'name': 'Vitamin',
                'category': 'Pharmacy',
                'default_tax_type': 'zero',
                'default_tax_rate': 0,
            },
            {
                'code': 'PHARMA-003',
                'name': 'Medical Device',
                'category': 'Pharmacy',
                'default_tax_type': 'zero',
                'default_tax_rate': 0,
            },
            
            # FUEL
            {
                'code': 'FUEL-001',
                'name': 'Petrol',
                'category': 'Fuel',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            {
                'code': 'FUEL-002',
                'name': 'Diesel',
                'category': 'Fuel',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            {
                'code': 'FUEL-003',
                'name': 'Kerosene',
                'category': 'Fuel',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            
            # SERVICES
            {
                'code': 'SERVICE-001',
                'name': 'Haircut',
                'category': 'Services',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            {
                'code': 'SERVICE-002',
                'name': 'Repair Service',
                'category': 'Services',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            {
                'code': 'SERVICE-003',
                'name': 'Consultation',
                'category': 'Services',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            {
                'code': 'SERVICE-004',
                'name': 'Delivery',
                'category': 'Services',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            
            # RETAIL
            {
                'code': 'RETAIL-001',
                'name': 'Clothing',
                'category': 'Retail',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            {
                'code': 'RETAIL-002',
                'name': 'Electronics',
                'category': 'Retail',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
            {
                'code': 'RETAIL-003',
                'name': 'Household Items',
                'category': 'Retail',
                'default_tax_type': 'standard',
                'default_tax_rate': 16.5,
            },
        ]

        if not mra_products:
            mra_products = fallback_products

        # Filter by search query if provided
        if search_query:
            mra_products = [
                p for p in mra_products
                if search_query in p['code'].lower()
                or search_query in p['name'].lower()
                or search_query in p.get('category', '').lower()
            ]

        if include_meta:
            return Response(
                {
                    'results': mra_products,
                    'count': len(mra_products),
                    'source': catalog_source,
                    'config_version': config_version,
                    'business_id': str(business.id) if business else None,
                },
                status=status.HTTP_200_OK
            )

        return Response(mra_products, status=status.HTTP_200_OK)


class PreparePendingPOSOrdersView(APIView):
    """
    Prepare pending POS orders for MRA submission without forcing live submission.

    This endpoint is rollout-safe when dry-run is enabled.
    """
    permission_classes = [IsAuthenticated]

    def post(self, request):
        business_id = request.query_params.get('business_id')
        branch_id = request.query_params.get('branch_id')
        limit = request.data.get('limit', 100)

        try:
            limit = int(limit)
        except (TypeError, ValueError):
            limit = 100

        accessible_businesses = _get_accessible_business_queryset(request.user)
        if not accessible_businesses.exists():
            return Response(
                {'error': 'User has no accessible business for MRA preparation.'},
                status=status.HTTP_403_FORBIDDEN
            )

        business = None
        if business_id:
            business = get_object_or_404(accessible_businesses, id=business_id)
        else:
            business = accessible_businesses.first()

        if not is_business_eis_enabled(business):
            return _eis_disabled_response()

        branch = None
        if branch_id:
            from business.models import Branch
            branch = get_object_or_404(Branch, id=branch_id, business=business)

        result = POSOrderSubmissionService.prepare_pending_pos_orders(
            business=business,
            branch=branch,
            limit=limit
        )

        return Response(
            {
                'business_id': str(business.id) if business else None,
                'branch_id': str(branch.id) if branch else None,
                **result,
            },
            status=status.HTTP_200_OK
        )
