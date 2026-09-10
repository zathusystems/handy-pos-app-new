from django.db import transaction
from django.utils import timezone
from rest_framework import permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from .models import PayrollEntry, PayrollLine, PayrollRun, PayrollSettings
from .payroll import generate_payroll_run, recalculate_entry, recalculate_run
from .serializers import (
    PayrollEntrySerializer,
    PayrollLineSerializer,
    PayrollLineWriteSerializer,
    PayrollRunSerializer,
    PayrollRunWriteSerializer,
    PayrollSettingsSerializer,
)
from .views import HRBusinessAccessMixin


class PayrollAdminMixin(HRBusinessAccessMixin):
    permission_classes = [permissions.IsAuthenticated]

    def require_payroll_admin(self, business_id):
        if not self.is_admin_for_business(business_id):
            raise PermissionDenied('Only the business owner or an Administrator can manage payroll.')


class PayrollSettingsViewSet(PayrollAdminMixin, viewsets.ModelViewSet):
    serializer_class = PayrollSettingsSerializer
    http_method_names = ['get', 'post', 'patch', 'head', 'options']

    def get_queryset(self):
        queryset = PayrollSettings.objects.select_related('business')
        return self.filter_business_queryset(queryset)

    def perform_create(self, serializer):
        serializer.save(business=self.get_requested_business())

    def perform_update(self, serializer):
        self.require_payroll_admin(serializer.instance.business_id)
        serializer.save()


class PayrollRunViewSet(PayrollAdminMixin, viewsets.ModelViewSet):
    http_method_names = ['get', 'post', 'patch', 'head', 'options']

    def get_queryset(self):
        queryset = PayrollRun.objects.select_related(
            'business', 'created_by', 'approved_by', 'paid_by',
        ).prefetch_related('entries__lines')
        return self.filter_business_queryset(queryset)

    def get_serializer_class(self):
        return PayrollRunWriteSerializer if self.action in {'create', 'partial_update', 'update'} else PayrollRunSerializer

    def perform_create(self, serializer):
        serializer.save(business=self.get_requested_business(), created_by=self.request.user)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        return Response(
            PayrollRunSerializer(serializer.instance, context=self.get_serializer_context()).data,
            status=status.HTTP_201_CREATED,
        )

    def perform_update(self, serializer):
        payroll_run = serializer.instance
        self.require_payroll_admin(payroll_run.business_id)
        if payroll_run.status != PayrollRun.Status.DRAFT:
            raise PermissionDenied('Only draft payroll runs can be edited.')
        serializer.save()

    @action(detail=True, methods=['post'])
    def generate(self, request, pk=None):
        payroll_run = self.get_object()
        self.require_payroll_admin(payroll_run.business_id)
        try:
            payroll_run = generate_payroll_run(payroll_run)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(PayrollRunSerializer(payroll_run, context=self.get_serializer_context()).data)

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        payroll_run = self.get_object()
        self.require_payroll_admin(payroll_run.business_id)
        if payroll_run.status != PayrollRun.Status.CALCULATED:
            return Response({'detail': 'Only calculated payroll runs can be approved.'}, status=status.HTTP_400_BAD_REQUEST)
        if not payroll_run.entries.exists():
            return Response({'detail': 'Generate the payroll run before approving it.'}, status=status.HTTP_400_BAD_REQUEST)
        payroll_run.status = PayrollRun.Status.APPROVED
        payroll_run.approved_by = request.user
        payroll_run.approved_at = timezone.now()
        payroll_run.save(update_fields=['status', 'approved_by', 'approved_at', 'updated_at'])
        return Response(PayrollRunSerializer(payroll_run, context=self.get_serializer_context()).data)

    @action(detail=True, methods=['post'], url_path='mark-paid')
    def mark_paid(self, request, pk=None):
        payroll_run = self.get_object()
        self.require_payroll_admin(payroll_run.business_id)
        if payroll_run.status != PayrollRun.Status.APPROVED:
            return Response({'detail': 'Only approved payroll runs can be marked paid.'}, status=status.HTTP_400_BAD_REQUEST)
        pay_date = request.data.get('pay_date') or payroll_run.pay_date or payroll_run.period_end
        payroll_run.pay_date = pay_date
        payroll_run.status = PayrollRun.Status.PAID
        payroll_run.paid_by = request.user
        payroll_run.paid_at = timezone.now()
        payroll_run.save(update_fields=['pay_date', 'status', 'paid_by', 'paid_at', 'updated_at'])
        return Response(PayrollRunSerializer(payroll_run, context=self.get_serializer_context()).data)

    @action(detail=True, methods=['post'])
    def void(self, request, pk=None):
        payroll_run = self.get_object()
        self.require_payroll_admin(payroll_run.business_id)
        if payroll_run.status not in {PayrollRun.Status.DRAFT, PayrollRun.Status.CALCULATED}:
            return Response({'detail': 'Only draft or calculated payroll runs can be voided.'}, status=status.HTTP_400_BAD_REQUEST)
        payroll_run.status = PayrollRun.Status.VOID
        payroll_run.notes = f'{payroll_run.notes}\nVoided: {str(request.data.get("reason") or "No reason provided")[:500]}'.strip()
        payroll_run.save(update_fields=['status', 'notes', 'updated_at'])
        return Response(PayrollRunSerializer(payroll_run, context=self.get_serializer_context()).data)


class PayrollEntryViewSet(PayrollAdminMixin, viewsets.ModelViewSet):
    serializer_class = PayrollEntrySerializer
    http_method_names = ['get', 'patch', 'head', 'options']

    def get_queryset(self):
        queryset = PayrollEntry.objects.select_related(
            'payroll_run', 'employee', 'employment_term',
        ).prefetch_related('lines')
        return self.filter_business_queryset(queryset, 'payroll_run__business_id')

    def perform_update(self, serializer):
        payroll_entry = serializer.instance
        self.require_payroll_admin(payroll_entry.payroll_run.business_id)
        if payroll_entry.payroll_run.status not in {PayrollRun.Status.DRAFT, PayrollRun.Status.CALCULATED}:
            raise PermissionDenied('Payslips cannot be edited after the payroll run is approved.')
        serializer.save()
        recalculate_run(payroll_entry.payroll_run)


class PayrollLineViewSet(PayrollAdminMixin, viewsets.ModelViewSet):
    http_method_names = ['get', 'post', 'patch', 'head', 'options']

    def get_queryset(self):
        queryset = PayrollLine.objects.select_related('payroll_entry__payroll_run', 'payroll_entry__employee')
        return self.filter_business_queryset(queryset, 'payroll_entry__payroll_run__business_id')

    def get_serializer_class(self):
        return PayrollLineWriteSerializer if self.action in {'create', 'partial_update', 'update'} else PayrollLineSerializer

    def perform_create(self, serializer):
        entry = serializer.validated_data['payroll_entry']
        self.require_payroll_admin(entry.payroll_run.business_id)
        serializer.save()
        recalculate_run(entry.payroll_run)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        return Response(
            PayrollLineSerializer(serializer.instance, context=self.get_serializer_context()).data,
            status=status.HTTP_201_CREATED,
        )

    def perform_update(self, serializer):
        line = serializer.instance
        self.require_payroll_admin(line.payroll_entry.payroll_run.business_id)
        serializer.save()
        recalculate_run(line.payroll_entry.payroll_run)
