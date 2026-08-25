"""
MRA EIS-Compliant Business Views

Provides API endpoints for business operations with MRA compliance:
- Taxpayer identity management
- Branch tracking
- Tax rate immutability enforcement
- Invoice immutability enforcement
- Relational line item handling
"""

from rest_framework import viewsets, permissions, status, filters, serializers
from rest_framework.decorators import action
from rest_framework.response import Response
from django.db import transaction
from django.db.models import Count, Q, Sum
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils import timezone
from decimal import Decimal
import re

from .models import (
    Business, Branch, BusinessSettings, TaxRate, BusinessCharge, Invoice, InvoiceLine,
    Customer, CustomerAccountTransaction, CustomerLaybuy, Expense
)
from .customer_accounts import collect_laybuy, record_customer_payment, record_laybuy_payment
from .serializers import (
    BusinessSerializer, BusinessDetailSerializer, BusinessCreateSerializer,
    BusinessUpdateSerializer, BranchSerializer, BranchCreateSerializer,
    BusinessSettingsSerializer, TaxRateSerializer, TaxRateCreateSerializer,
    TaxRateUpdateSerializer, BusinessChargeSerializer,
    BusinessChargeCreateUpdateSerializer, InvoiceSerializer, InvoiceDetailSerializer,
    InvoiceCreateSerializer, InvoiceUpdateSerializer, InvoiceLineSerializer,
    CustomerSerializer, CustomerCreateSerializer, CustomerAccountTransactionSerializer,
    CustomerPaymentSerializer, CustomerLaybuySerializer, CustomerLaybuyPaymentSerializer,
    LaybuyCreateSerializer, LaybuyPaymentSerializer, ExpenseSerializer,
    ExpenseCreateSerializer
)
from subscription.feature_access import SubscriptionFeatureGateMixin


# ============================================================================
# PERMISSIONS
# ============================================================================

class IsBusinessOwnerOrReadOnly(permissions.BasePermission):
    """Permission to check if user is business owner"""
    def has_object_permission(self, request, view, obj):
        if request.method in permissions.SAFE_METHODS:
            return True
        return obj.owner == request.user


def _default_main_branch_name(business_name):
    """
    Build a readable default main branch name with business initials.
    Example: "Acme Trading Limited" -> "ATL Main Branch".
    """
    parts = re.findall(r"[A-Za-z0-9]+", str(business_name or ""))
    initials = ''.join(part[0].upper() for part in parts if part)
    if not initials:
        return 'Main Branch'
    return f'{initials} Main Branch'


def _accessible_business_ids_for_user(user):
    """Businesses owned by the user or assigned through an active staff profile."""
    business_ids = list(Business.objects.filter(owner=user).values_list('id', flat=True))

    try:
        from staff.models import Staff
        staff_profile = Staff.objects.select_related('business').filter(
            user=user,
            is_active=True,
        ).first()
        if staff_profile and staff_profile.business_id:
            business_ids.append(staff_profile.business_id)
    except Exception:
        pass

    return list(dict.fromkeys(business_ids))


# ============================================================================
# BUSINESS VIEWSET
# ============================================================================

class BusinessViewSet(viewsets.ModelViewSet):
    """
    ViewSet for business management with MRA compliance.
    
    Supports:
    - List businesses
    - Create business
    - Retrieve business
    - Update business
    - Delete business
    - Add branch
    - Get settings
    - Add tax rate
    """
    permission_classes = [permissions.IsAuthenticated]
    queryset = Business.objects.all()
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'tin', 'email']
    ordering_fields = ['name', 'created_at', 'mra_enrolled']
    ordering = ['-created_at']

    def get_queryset(self):
        """Filter businesses by owner or staff assignment"""
        from staff.models import Staff
        
        # Get businesses owned by user
        owned_businesses = Business.objects.filter(owner=self.request.user)
        
        # Get businesses where user is a staff member
        try:
            staff = Staff.objects.get(user=self.request.user)
            if staff.business:
                # Combine owned businesses with assigned business
                return Business.objects.filter(
                    id__in=list(owned_businesses.values_list('id', flat=True)) + [staff.business.id]
                ).distinct()
        except Staff.DoesNotExist:
            pass
        
        return owned_businesses

    def get_serializer_class(self):
        """Choose serializer based on action"""
        if self.action == 'create':
            return BusinessCreateSerializer
        elif self.action in ['update', 'partial_update']:
            return BusinessUpdateSerializer
        elif self.action == 'retrieve':
            return BusinessDetailSerializer
        return BusinessSerializer

    @transaction.atomic
    def perform_create(self, serializer):
        """Create business with auto-setup"""
        business = serializer.save(owner=self.request.user)

        # Auto-create settings. Restaurant-style businesses need kitchen flow
        # enabled immediately so POS, take orders, and kitchen display align.
        restaurant_kitchen_enabled = business.business_type in {'restaurant', 'bar_liquor'}
        biz_settings = BusinessSettings.objects.create(
            business=business,
            enable_kitchen=restaurant_kitchen_enabled,
        )
        requested_currency = str(getattr(serializer, '_requested_currency', '') or '').strip().upper()
        if requested_currency in {'USD', 'MWK'} and biz_settings.currency != requested_currency:
            biz_settings.currency = requested_currency
            biz_settings.save(update_fields=['currency'])

        # Auto-create default main branch
        main_branch = Branch.objects.create(
            business=business,
            name=_default_main_branch_name(business.name),
            address='',
            city='',
            country='',
            is_active=True
        )

        # Auto-add business creator as Admin staff member
        try:
            from staff.models import Staff, StaffRole
            user_name = ''
            if self.request.user.first_name or self.request.user.last_name:
                user_name = f"{self.request.user.first_name} {self.request.user.last_name}".strip()
            user_name = user_name or self.request.user.email or self.request.user.phone or 'Admin'

            if self.request.user.email:
                staff, created = Staff.objects.get_or_create(
                    user=self.request.user,
                    defaults={
                        'business': business,
                        'branch': main_branch,
                        'name': user_name,
                        'email': self.request.user.email,
                        'phone': self.request.user.phone or '',
                        'role': 'Admin',
                        'is_active': True
                    }
                )
                if not created:
                    # Keep owner's staff profile aligned to the newly created business.
                    # Without this, existing profiles may keep a null/old branch assignment.
                    fields_to_update = []

                    if staff.business_id != business.id:
                        staff.business = business
                        fields_to_update.append('business')

                    if staff.branch_id != main_branch.id:
                        staff.branch = main_branch
                        fields_to_update.append('branch')

                    if staff.role != StaffRole.ADMIN:
                        staff.role = StaffRole.ADMIN
                        fields_to_update.append('role')

                    if not staff.is_active:
                        staff.is_active = True
                        fields_to_update.append('is_active')

                    if fields_to_update:
                        staff.save(update_fields=fields_to_update)
        except Exception as e:
            # Don't fail business creation if staff creation fails
            pass

    def perform_update(self, serializer):
        """Update business"""
        serializer.save()

    @action(detail=True, methods=['post'])
    def add_branch(self, request, pk=None):
        """Add a new branch to business"""
        business = self.get_object()
        serializer = BranchCreateSerializer(data=request.data)
        if serializer.is_valid():
            serializer.save(business=business)
            return Response(
                BranchSerializer(serializer.instance).data,
                status=status.HTTP_201_CREATED
            )
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['get', 'put'])
    def business_settings(self, request, pk=None):
        """Get or update business settings"""
        business = self.get_object()
        biz_settings = business.settings

        if request.method == 'PUT':
            serializer = BusinessSettingsSerializer(
                biz_settings,
                data=request.data,
                partial=True
            )
            if serializer.is_valid():
                serializer.save()
                return Response(serializer.data)
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        serializer = BusinessSettingsSerializer(biz_settings)
        return Response(serializer.data)

    @action(detail=True, methods=['get'])
    def branches(self, request, pk=None):
        """Get all branches for business"""
        business = self.get_object()
        branches = business.branches.all()
        serializer = BranchSerializer(branches, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def add_tax_rate(self, request, pk=None):
        """Add a new tax rate to business"""
        business = self.get_object()
        serializer = TaxRateCreateSerializer(data=request.data)
        if serializer.is_valid():
            serializer.save(business=business, created_by=request.user)
            return Response(
                TaxRateSerializer(serializer.instance).data,
                status=status.HTTP_201_CREATED
            )
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['get'])
    def tax_rates(self, request, pk=None):
        """Get all tax rates for business"""
        business = self.get_object()
        tax_rates = business.tax_rates.filter(is_active=True)
        serializer = TaxRateSerializer(tax_rates, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['get'])
    def mra_status(self, request, pk=None):
        """Get MRA enrollment status"""
        business = self.get_object()
        return Response({
            'tin': business.tin,
            'vat_registered': business.vat_registered,
            'mra_taxpayer_type': business.mra_taxpayer_type,
            'mra_enrolled': business.mra_enrolled,
            'mra_enrolled_at': business.mra_enrolled_at,
        })


# ============================================================================
# BRANCH VIEWSET
# ============================================================================

class BranchViewSet(viewsets.ModelViewSet):
    """
    ViewSet for branch management with MRA tracking.
    
    Supports:
    - List branches
    - Create branch
    - Retrieve branch
    - Update branch
    - Delete branch
    """
    serializer_class = BranchSerializer
    permission_classes = [permissions.IsAuthenticated]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'city', 'mra_branch_code']
    ordering_fields = ['name', 'created_at']
    ordering = ['-created_at']

    def get_queryset(self):
        """Filter branches by business owner"""
        return Branch.objects.filter(business__owner=self.request.user)

    def get_serializer_class(self):
        """Choose serializer based on action"""
        if self.action in ['create', 'update', 'partial_update']:
            return BranchCreateSerializer
        return BranchSerializer

    def perform_create(self, serializer):
        """Create branch"""
        serializer.save()


# ============================================================================
# TAX RATE VIEWSET
# ============================================================================

class TaxRateViewSet(SubscriptionFeatureGateMixin, viewsets.ModelViewSet):
    """
    ViewSet for tax rate management with immutability enforcement.
    
    CRITICAL: Tax rates are locked after use and cannot be modified.
    
    Supports:
    - List tax rates
    - Create tax rate
    - Retrieve tax rate
    - Update tax rate (with immutability check)
    - Delete tax rate
    - Set default tax rate
    """
    permission_classes = [permissions.IsAuthenticated]
    required_subscription_feature = 'tax_management'
    feature_gate_actions = {'create', 'update', 'partial_update', 'destroy', 'set_default'}
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'tax_type', 'mra_tax_code']
    ordering_fields = ['name', 'rate', 'is_default', 'created_at']
    ordering = ['-is_default', '-created_at']

    def get_queryset(self):
        """Filter tax rates by business owner"""
        return TaxRate.objects.filter(business__owner=self.request.user)

    def get_serializer_class(self):
        """Choose serializer based on action"""
        if self.action == 'create':
            return TaxRateCreateSerializer
        elif self.action in ['update', 'partial_update']:
            return TaxRateUpdateSerializer
        return TaxRateSerializer

    def perform_create(self, serializer):
        """Create tax rate"""
        business = self.request.user.businesses.first()
        if not business:
            raise serializers.ValidationError('User must have a business')
        serializer.save(business=business, created_by=self.request.user)

    def _ensure_tax_rate_mutable(self, tax_rate: TaxRate) -> None:
        """Prevent updates/deletes for locked tax rates."""
        if tax_rate.locked:
            raise serializers.ValidationError(
                {'error': 'Cannot modify a locked tax rate. Create a new tax rate instead.'}
            )

    def perform_update(self, serializer):
        """Update tax rate with immutability check"""
        self._ensure_tax_rate_mutable(serializer.instance)
        serializer.save()

    def perform_destroy(self, instance):
        """Delete tax rate with immutability check"""
        self._ensure_tax_rate_mutable(instance)
        super().perform_destroy(instance)

    @action(detail=True, methods=['post'])
    def set_default(self, request, pk=None):
        """Set this tax rate as default for business"""
        tax_rate = self.get_object()

        # Unset all other defaults for this business
        TaxRate.objects.filter(business=tax_rate.business).update(is_default=False)

        # Set this one as default
        tax_rate.is_default = True
        tax_rate.save()

        return Response(TaxRateSerializer(tax_rate).data)

    @action(detail=False, methods=['get'])
    def active(self, request):
        """Get all active tax rates"""
        tax_rates = self.get_queryset().filter(is_active=True)
        serializer = self.get_serializer(tax_rates, many=True)
        return Response(serializer.data)


class BusinessChargeViewSet(SubscriptionFeatureGateMixin, viewsets.ModelViewSet):
    """Manage business-level charges such as levies and service charges."""

    permission_classes = [permissions.IsAuthenticated]
    required_subscription_feature = 'tax_management'
    feature_gate_actions = {'create', 'update', 'partial_update', 'destroy'}
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'charge_type']
    ordering_fields = ['name', 'rate', 'created_at']
    ordering = ['name']

    def get_queryset(self):
        business_ids = _accessible_business_ids_for_user(self.request.user)
        return BusinessCharge.objects.filter(business_id__in=business_ids)

    def get_serializer_class(self):
        if self.action in {'create', 'update', 'partial_update'}:
            return BusinessChargeCreateUpdateSerializer
        return BusinessChargeSerializer

    def perform_create(self, serializer):
        business = Business.objects.filter(id__in=_accessible_business_ids_for_user(self.request.user)).first()
        if not business:
            raise serializers.ValidationError('User must have a business')
        serializer.save(business=business, created_by=self.request.user)

    @action(detail=False, methods=['get'])
    def active(self, request):
        today = timezone.localdate()
        charges = self.get_queryset().filter(
            is_active=True,
            auto_apply=True,
            effective_from__lte=today,
        ).filter(
            Q(effective_to__isnull=True) | Q(effective_to__gte=today)
        )
        serializer = self.get_serializer(charges, many=True)
        return Response(serializer.data)


# ============================================================================
# CUSTOMER VIEWSET
# ============================================================================

class CustomerViewSet(viewsets.ModelViewSet):
    """
    ViewSet for customer account management with VAT and credit tracking.
    
    Supports:
    - List customers
    - Create customer
    - Retrieve customer
    - Update customer
    - Delete customer
    """
    permission_classes = [permissions.IsAuthenticated]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'email', 'phone', 'customer_tin']
    ordering_fields = ['name', 'created_at', 'vat_registered', 'current_balance', 'credit_limit']
    ordering = ['-created_at']

    def get_queryset(self):
        """Filter customers by owner/staff business access and optional branch"""
        business_ids = _accessible_business_ids_for_user(self.request.user)
        queryset = Customer.objects.filter(business_id__in=business_ids)

        branch_id = self.request.query_params.get('branch') or self.request.query_params.get('branch_id')
        if branch_id:
            queryset = queryset.filter(branch_id=branch_id)

        balance_state = str(self.request.query_params.get('balance_state') or '').strip().lower()
        if balance_state == 'owing':
            queryset = queryset.filter(current_balance__gt=0)
        elif balance_state == 'credit':
            queryset = queryset.filter(current_balance__lt=0)

        return queryset

    def get_serializer_class(self):
        """Choose serializer based on action"""
        if self.action in ['create', 'update', 'partial_update']:
            return CustomerCreateSerializer
        return CustomerSerializer

    def _resolve_business_for_customer_write(self, serializer):
        branch = serializer.validated_data.get('branch')
        business_ids = _accessible_business_ids_for_user(self.request.user)

        if branch:
            if branch.business_id not in business_ids:
                raise serializers.ValidationError('Selected branch is not available for your account')
            return branch.business, branch

        business = Business.objects.filter(id__in=business_ids).first()
        if not business:
            raise serializers.ValidationError('User must have a business')
        return business, None

    def _resolve_payment_session(self, request, branch, validated_data):
        raw_session_id = (
            validated_data.get('session')
            or request.data.get('session_id')
            or request.data.get('sessionId')
        )

        try:
            from pos_sessions.models import Session
        except Exception:
            return None

        queryset = Session.objects.filter(
            status='active',
            business_id__in=_accessible_business_ids_for_user(request.user),
        )

        if raw_session_id:
            session = queryset.filter(id=raw_session_id).first()
            if not session:
                raise serializers.ValidationError({'session': 'Active payment session was not found.'})
            if branch and session.branch_id != branch.id:
                raise serializers.ValidationError({'session': 'Payment session does not belong to this branch.'})
            return session

        if branch:
            queryset = queryset.filter(branch=branch)

        return queryset.filter(user=request.user).order_by('-started_at').first()

    def _invoice_balance_due(self, invoice):
        if invoice.document_type != 'Invoice' or invoice.status in {'Paid', 'Void'}:
            return Decimal('0.00')

        filters = Q(invoice_id=str(invoice.id))
        if invoice.related_order_id:
            filters |= Q(order_id=str(invoice.related_order_id))

        transactions = CustomerAccountTransaction.objects.filter(
            filters,
            business=invoice.business,
        )
        debit_total = transactions.filter(direction='debit').aggregate(total=Sum('amount'))['total'] or Decimal('0.00')
        credit_total = transactions.filter(direction='credit').aggregate(total=Sum('amount'))['total'] or Decimal('0.00')
        if debit_total or credit_total:
            return max(Decimal('0.00'), debit_total - credit_total)

        return Decimal(invoice.total or 0) if invoice.status == 'Sent' else Decimal('0.00')

    def perform_create(self, serializer):
        """Create customer"""
        business, branch = self._resolve_business_for_customer_write(serializer)
        serializer.save(business=business, branch=branch)

    def perform_update(self, serializer):
        instance = serializer.instance
        branch = serializer.validated_data.get('branch', instance.branch)
        business_ids = _accessible_business_ids_for_user(self.request.user)

        if branch:
            if branch.business_id not in business_ids:
                raise serializers.ValidationError('Selected branch is not available for your account')
            business = branch.business
        else:
            business = instance.business

        serializer.save(business=business, branch=branch)

    def create(self, request, *args, **kwargs):
        """Create customer and return the full read payload, including id."""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        read_serializer = CustomerSerializer(
            serializer.instance,
            context=self.get_serializer_context(),
        )
        headers = self.get_success_headers(read_serializer.data)
        return Response(read_serializer.data, status=status.HTTP_201_CREATED, headers=headers)

    @transaction.atomic
    def update(self, request, *args, **kwargs):
        """Update customer and return the full read payload, including id."""
        partial = kwargs.pop('partial', False)
        instance = self.get_object()
        serializer = self.get_serializer(instance, data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)
        self.perform_update(serializer)

        if getattr(instance, '_prefetched_objects_cache', None):
            instance._prefetched_objects_cache = {}

        read_serializer = CustomerSerializer(
            serializer.instance,
            context=self.get_serializer_context(),
        )
        return Response(read_serializer.data)

    @action(detail=True, methods=['get'])
    def transactions(self, request, pk=None):
        """Recent ledger entries for this customer account"""
        customer = self.get_object()
        try:
            limit = max(1, min(100, int(request.query_params.get('limit', 25))))
        except (TypeError, ValueError):
            limit = 25

        queryset = customer.account_transactions.select_related('branch', 'created_by')[:limit]
        serializer = CustomerAccountTransactionSerializer(queryset, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'], url_path='payments')
    @transaction.atomic
    def record_payment(self, request, pk=None):
        """Record a customer payment against their account balance"""
        customer = self.get_object()
        serializer = CustomerPaymentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        branch = serializer.validated_data.get('branch') or customer.branch
        if branch and branch.business_id != customer.business_id:
            return Response(
                {'error': 'Payment branch does not belong to this customer business'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            payment_session = self._resolve_payment_session(request, branch, serializer.validated_data)
            invoice = serializer.validated_data.get('invoice')
            invoice_order_id = None
            if invoice:
                if invoice.business_id != customer.business_id or invoice.customer_id != customer.id:
                    return Response(
                        {'error': 'Invoice does not belong to this customer account'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if branch and invoice.branch_id and invoice.branch_id != branch.id:
                    return Response(
                        {'error': 'Invoice does not belong to this payment branch'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                invoice_balance_due = self._invoice_balance_due(invoice)
                if invoice_balance_due <= 0:
                    return Response(
                        {'error': 'This invoice has no remaining balance due'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if serializer.validated_data['amount'] > invoice_balance_due:
                    return Response(
                        {'error': f'Payment exceeds invoice balance due of {invoice_balance_due}.'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                invoice_order_id = invoice.related_order_id

            account_tx = record_customer_payment(
                customer=customer,
                amount=serializer.validated_data['amount'],
                branch=branch,
                session=payment_session,
                order_id=invoice_order_id,
                invoice_id=str(invoice.id) if invoice else None,
                payment_method=serializer.validated_data.get('payment_method', 'Cash'),
                reference=serializer.validated_data.get('reference', ''),
                notes=serializer.validated_data.get('notes', ''),
                created_by=request.user,
            )
            if invoice:
                invoice.refresh_from_db()
                if self._invoice_balance_due(invoice) <= 0 and invoice.status != 'Paid':
                    invoice.status = 'Paid'
                    invoice.is_dirty = True
                    invoice.save(update_fields=['status', 'is_dirty', 'updated_at'])
                    invoice.refresh_from_db()
        except DjangoValidationError as exc:
            return Response({'error': exc.message if hasattr(exc, 'message') else str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        customer.refresh_from_db()
        payload = {
            'customer': CustomerSerializer(customer).data,
            'transaction': CustomerAccountTransactionSerializer(account_tx).data,
        }
        if invoice:
            payload['invoice'] = InvoiceDetailSerializer(
                invoice,
                context=self.get_serializer_context(),
            ).data
        return Response(payload, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['get', 'post'], url_path='laybuys')
    @transaction.atomic
    def laybuys(self, request, pk=None):
        """List or create laybuys for this customer"""
        customer = self.get_object()

        if request.method.lower() == 'get':
            queryset = customer.laybuys.select_related('branch', 'created_by').prefetch_related('payments', 'reservations')
            status_filter = str(request.query_params.get('status') or '').strip().lower()
            if status_filter:
                queryset = queryset.filter(status=status_filter)
            serializer = CustomerLaybuySerializer(queryset, many=True)
            return Response(serializer.data)

        serializer = LaybuyCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        branch = serializer.validated_data.get('branch') or customer.branch
        if branch and branch.business_id != customer.business_id:
            return Response(
                {'error': 'Laybuy branch does not belong to this customer business'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        total = serializer.validated_data['total']
        laybuy = CustomerLaybuy.objects.create(
            business=customer.business,
            branch=branch,
            customer=customer,
            subtotal=total,
            total=total,
            balance_due=total,
            due_date=serializer.validated_data.get('due_date'),
            notes=serializer.validated_data.get('notes', ''),
            created_by=request.user,
        )

        deposit_amount = serializer.validated_data.get('deposit_amount')
        if deposit_amount and deposit_amount > 0:
            try:
                payment_session = self._resolve_payment_session(request, branch, serializer.validated_data)
                record_laybuy_payment(
                    laybuy=laybuy,
                    amount=deposit_amount,
                    branch=branch,
                    session=payment_session,
                    payment_method=serializer.validated_data.get('payment_method', 'Cash'),
                    reference=serializer.validated_data.get('reference', ''),
                    notes='Initial laybuy deposit',
                    created_by=request.user,
                )
                laybuy.refresh_from_db()
            except DjangoValidationError as exc:
                return Response({'error': exc.message if hasattr(exc, 'message') else str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(CustomerLaybuySerializer(laybuy).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'], url_path='laybuy_payment')
    @transaction.atomic
    def laybuy_payment(self, request, pk=None):
        """Record a deposit/installment against a customer laybuy"""
        customer = self.get_object()
        serializer = LaybuyPaymentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        laybuy = CustomerLaybuy.objects.filter(
            id=serializer.validated_data['laybuy_id'],
            customer=customer,
            business=customer.business,
        ).first()
        if not laybuy:
            return Response({'error': 'Laybuy was not found for this customer'}, status=status.HTTP_404_NOT_FOUND)

        branch = serializer.validated_data.get('branch') or laybuy.branch or customer.branch
        if branch and branch.business_id != customer.business_id:
            return Response(
                {'error': 'Payment branch does not belong to this customer business'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            payment_session = self._resolve_payment_session(request, branch, serializer.validated_data)
            payment = record_laybuy_payment(
                laybuy=laybuy,
                amount=serializer.validated_data['amount'],
                branch=branch,
                session=payment_session,
                payment_method=serializer.validated_data.get('payment_method', 'Cash'),
                reference=serializer.validated_data.get('reference', ''),
                notes=serializer.validated_data.get('notes', ''),
                created_by=request.user,
            )
        except DjangoValidationError as exc:
            return Response({'error': exc.message if hasattr(exc, 'message') else str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        laybuy.refresh_from_db()
        return Response(
            {
                'laybuy': CustomerLaybuySerializer(laybuy).data,
                'payment': CustomerLaybuyPaymentSerializer(payment).data,
            },
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=['post'], url_path='laybuy_collect')
    @transaction.atomic
    def laybuy_collect(self, request, pk=None):
        """Mark a fully paid laybuy as collected and consume reserved stock."""
        customer = self.get_object()
        laybuy_id = request.data.get('laybuy_id') or request.data.get('laybuyId') or request.data.get('id')
        if not laybuy_id:
            return Response({'error': 'laybuy_id is required'}, status=status.HTTP_400_BAD_REQUEST)

        laybuy = CustomerLaybuy.objects.filter(
            id=laybuy_id,
            customer=customer,
            business=customer.business,
        ).first()
        if not laybuy:
            return Response({'error': 'Laybuy was not found for this customer'}, status=status.HTTP_404_NOT_FOUND)

        try:
            collected_laybuy = collect_laybuy(laybuy, created_by=request.user)
        except DjangoValidationError as exc:
            return Response({'error': exc.message if hasattr(exc, 'message') else str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        collected_laybuy.refresh_from_db()
        return Response({'laybuy': CustomerLaybuySerializer(collected_laybuy).data})

    @action(detail=False, methods=['get'])
    def account_summary(self, request):
        """Customer account totals for dashboard cards"""
        queryset = self.get_queryset()
        totals = queryset.aggregate(
            total_outstanding=Sum('current_balance'),
            total_customers=Count('id'),
        )
        owing_customers = queryset.filter(current_balance__gt=0).count()
        credit_customers = queryset.filter(current_balance__lt=0).count()
        active_laybuys = CustomerLaybuy.objects.filter(
            customer__in=queryset,
            status__in=['active', 'ready_for_collection'],
        )
        laybuy_totals = active_laybuys.aggregate(
            active_count=Count('id'),
            total_reserved=Sum('total'),
            paid_total=Sum('paid_amount'),
            balance_due=Sum('balance_due'),
        )
        return Response({
            'total_customers': totals.get('total_customers') or 0,
            'owing_customers': owing_customers,
            'credit_customers': credit_customers,
            'total_outstanding': totals.get('total_outstanding') or 0,
            'laybuy_active_count': laybuy_totals.get('active_count') or 0,
            'laybuy_reserved_total': laybuy_totals.get('total_reserved') or 0,
            'laybuy_paid_total': laybuy_totals.get('paid_total') or 0,
            'laybuy_balance_due': laybuy_totals.get('balance_due') or 0,
        })


# ============================================================================
# INVOICE VIEWSET
# ============================================================================

class InvoiceViewSet(viewsets.ModelViewSet):
    """
    ViewSet for invoice management with MRA EIS compliance.
    
    CRITICAL: Invoices are immutable after payment or MRA submission.
    
    Supports:
    - List invoices
    - Create invoice (with line items)
    - Retrieve invoice
    - Update invoice (with immutability check)
    - Delete invoice
    - Submit to MRA
    - Get invoice lines
    """
    permission_classes = [permissions.IsAuthenticated]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['invoice_number', 'customer_name', 'mra_invoice_number']
    ordering_fields = ['invoice_number', 'status', 'mra_status', 'created_at']
    ordering = ['-created_at']

    def get_queryset(self):
        """Filter invoices by business owner"""
        queryset = Invoice.objects.filter(business__owner=self.request.user).select_related(
            'branch',
            'customer',
        ).prefetch_related('lines')
        branch_id = self.request.query_params.get('branch_id')
        if branch_id:
            queryset = queryset.filter(branch_id=branch_id)
        customer_id = self.request.query_params.get('customer') or self.request.query_params.get('customer_id')
        if customer_id:
            queryset = queryset.filter(customer_id=customer_id)
        document_type = self.request.query_params.get('document_type') or self.request.query_params.get('documentType')
        if document_type:
            queryset = queryset.filter(document_type=document_type)
        return queryset

    def get_serializer_class(self):
        """Choose serializer based on action"""
        if self.action == 'create':
            return InvoiceCreateSerializer
        elif self.action in ['update', 'partial_update']:
            return InvoiceUpdateSerializer
        elif self.action == 'retrieve':
            return InvoiceDetailSerializer
        return InvoiceSerializer

    @transaction.atomic
    def perform_create(self, serializer):
        """Create invoice"""
        business = self.request.user.businesses.first()
        if not business:
            raise serializers.ValidationError('User must have a business')
        serializer.save(business=business)

    def create(self, request, *args, **kwargs):
        """Create invoice/quotation and return the full document with lines."""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        read_serializer = InvoiceDetailSerializer(
            serializer.instance,
            context=self.get_serializer_context(),
        )
        headers = self.get_success_headers(read_serializer.data)
        return Response(read_serializer.data, status=status.HTTP_201_CREATED, headers=headers)

    def perform_update(self, serializer):
        """Update invoice with immutability check"""
        try:
            serializer.save()
        except DjangoValidationError as e:
            raise serializers.ValidationError({'error': str(e)})

    def update(self, request, *args, **kwargs):
        """Update invoice/quotation and return the full document with lines."""
        partial = kwargs.pop('partial', False)
        instance = self.get_object()
        serializer = self.get_serializer(instance, data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)
        self.perform_update(serializer)
        read_serializer = InvoiceDetailSerializer(
            serializer.instance,
            context=self.get_serializer_context(),
        )
        return Response(read_serializer.data)

    @action(detail=True, methods=['get'])
    def lines(self, request, pk=None):
        """Get all line items for invoice"""
        invoice = self.get_object()
        lines = invoice.lines.all()
        serializer = InvoiceLineSerializer(lines, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def submit_to_mra(self, request, pk=None):
        """Submit invoice to MRA"""
        invoice = self.get_object()

        # Check if already submitted
        if invoice.mra_status == 'SUBMITTED':
            return Response(
                {'error': 'Invoice already submitted to MRA'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Check if locked
        if invoice.is_locked:
            return Response(
                {'error': 'Cannot submit locked invoice'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # TODO: Integrate with MRA EIS API
        # For now, just update status
        invoice.mra_status = 'SUBMITTED'
        invoice.is_locked = True
        invoice.save()

        return Response(
            InvoiceSerializer(invoice).data,
            status=status.HTTP_200_OK
        )

    @action(detail=True, methods=['post'])
    def mark_paid(self, request, pk=None):
        """Mark invoice as paid (locks it)"""
        invoice = self.get_object()

        if invoice.is_locked:
            return Response(
                {'error': 'Invoice is already locked'},
                status=status.HTTP_400_BAD_REQUEST
            )

        invoice.status = 'Paid'
        invoice.is_locked = True
        invoice.save()

        return Response(
            InvoiceSerializer(invoice).data,
            status=status.HTTP_200_OK
        )

    @action(detail=False, methods=['get'])
    def pending_mra_submission(self, request):
        """Get invoices pending MRA submission"""
        invoices = self.get_queryset().filter(mra_status='PENDING')
        serializer = self.get_serializer(invoices, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def mra_submitted(self, request):
        """Get invoices submitted to MRA"""
        invoices = self.get_queryset().filter(mra_status='SUBMITTED')
        serializer = self.get_serializer(invoices, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def locked(self, request):
        """Get locked invoices"""
        invoices = self.get_queryset().filter(is_locked=True)
        serializer = self.get_serializer(invoices, many=True)
        return Response(serializer.data)


# ============================================================================
# EXPENSE VIEWSET
# ============================================================================

class ExpenseViewSet(SubscriptionFeatureGateMixin, viewsets.ModelViewSet):
    """
    ViewSet for expense management.
    
    Supports:
    - List expenses
    - Create expense
    - Retrieve expense
    - Update expense
    - Delete expense
    - Filter by branch
    """
    permission_classes = [permissions.IsAuthenticated]
    required_subscription_feature = 'expense_management'
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['title', 'category']
    ordering_fields = ['title', 'amount', 'date', 'status', 'created_at']
    ordering = ['-created_at']

    def get_queryset(self):
        """Filter expenses by business owner and optionally by branch"""
        queryset = Expense.objects.filter(business__owner=self.request.user)
        
        # Filter by branch if provided in query parameters
        branch_id = self.request.query_params.get('branch', None)
        if branch_id:
            queryset = queryset.filter(branch_id=branch_id)
        
        return queryset

    def get_serializer_class(self):
        """Choose serializer based on action"""
        if self.action in ['create', 'update', 'partial_update']:
            return ExpenseCreateSerializer
        return ExpenseSerializer

    def perform_create(self, serializer):
        """Create expense"""
        business = self.request.user.businesses.first()
        if not business:
            raise serializers.ValidationError('User must have a business')
        serializer.save(
            business=business,
            created_by=self.request.user.email,
            status='Approved',
            approved_by=self.request.user.email,
            approved_at=timezone.now(),
        )
