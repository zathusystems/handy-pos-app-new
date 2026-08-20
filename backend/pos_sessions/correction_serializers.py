from rest_framework import serializers
from .models import CreditNote, DebitNote, VoidTransaction, Order


def _resolve_eis_sync_state(eis_status: str | None) -> str:
    status = str(eis_status or '').upper()
    return {
        'PENDING': 'PENDING',
        'SUBMITTED': 'SENDING',
        'ACCEPTED': 'SUCCESS',
        'REJECTED': 'FAILED',
    }.get(status, 'PENDING')


class CreditNoteSerializer(serializers.ModelSerializer):
    """Serializer for Credit Notes"""
    original_order_number = serializers.CharField(source='original_order.order_number', read_only=True)
    created_by_name = serializers.CharField(source='created_by.get_full_name', read_only=True)
    eis_sync_state = serializers.SerializerMethodField()
    
    class Meta:
        model = CreditNote
        fields = [
            'id',
            'credit_note_number',
            'original_order',
            'original_order_number',
            'reason',
            'description',
            'credit_amount',
            'vat_amount',
            'total_credit',
            'fiscal_credit_number',
            'eis_status',
            'eis_sync_state',
            'eis_submitted_at',
            'is_fiscal_locked',
            'created_by',
            'created_by_name',
            'created_at',
            'updated_at',
        ]
        read_only_fields = [
            'id',
            'credit_note_number',
            'fiscal_credit_number',
            'eis_uuid',
            'eis_status',
            'eis_submitted_at',
            'qr_code_payload',
            'digital_signature',
            'is_fiscal_locked',
            'created_by',
            'created_at',
            'updated_at',
        ]

    def get_eis_sync_state(self, obj):
        return _resolve_eis_sync_state(getattr(obj, 'eis_status', None))


class DebitNoteSerializer(serializers.ModelSerializer):
    """Serializer for Debit Notes"""
    original_order_number = serializers.CharField(source='original_order.order_number', read_only=True)
    created_by_name = serializers.CharField(source='created_by.get_full_name', read_only=True)
    eis_sync_state = serializers.SerializerMethodField()
    
    class Meta:
        model = DebitNote
        fields = [
            'id',
            'debit_note_number',
            'original_order',
            'original_order_number',
            'description',
            'additional_amount',
            'vat_amount',
            'total_debit',
            'fiscal_debit_number',
            'eis_status',
            'eis_sync_state',
            'eis_submitted_at',
            'is_fiscal_locked',
            'created_by',
            'created_by_name',
            'created_at',
            'updated_at',
        ]
        read_only_fields = [
            'id',
            'debit_note_number',
            'fiscal_debit_number',
            'eis_uuid',
            'eis_status',
            'eis_submitted_at',
            'qr_code_payload',
            'digital_signature',
            'is_fiscal_locked',
            'created_by',
            'created_at',
            'updated_at',
        ]

    def get_eis_sync_state(self, obj):
        return _resolve_eis_sync_state(getattr(obj, 'eis_status', None))


class VoidTransactionSerializer(serializers.ModelSerializer):
    """Serializer for Void Transactions"""
    original_order_number = serializers.CharField(source='original_order.order_number', read_only=True)
    original_order_total = serializers.DecimalField(source='original_order.total', read_only=True, max_digits=12, decimal_places=2)
    created_by_name = serializers.CharField(source='created_by.get_full_name', read_only=True)
    eis_sync_state = serializers.SerializerMethodField()
    
    class Meta:
        model = VoidTransaction
        fields = [
            'id',
            'void_number',
            'original_order',
            'original_order_number',
            'original_order_total',
            'void_reason',
            'reason_description',
            'voided_amount',
            'voided_vat',
            'refund_method',
            'fiscal_void_number',
            'eis_status',
            'eis_sync_state',
            'eis_submitted_at',
            'is_fiscal_locked',
            'created_by',
            'created_by_name',
            'created_at',
            'updated_at',
        ]
        read_only_fields = [
            'id',
            'void_number',
            'fiscal_void_number',
            'eis_uuid',
            'eis_status',
            'eis_submitted_at',
            'qr_code_payload',
            'digital_signature',
            'is_fiscal_locked',
            'created_by',
            'created_at',
            'updated_at',
        ]

    def get_eis_sync_state(self, obj):
        return _resolve_eis_sync_state(getattr(obj, 'eis_status', None))


class CreateCreditNoteSerializer(serializers.Serializer):
    """Serializer for creating a Credit Note"""
    original_order_id = serializers.UUIDField()
    reason = serializers.ChoiceField(choices=CreditNote.REASON_CHOICES)
    description = serializers.CharField(max_length=1000)
    credit_amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    vat_amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    
    def validate_original_order_id(self, value):
        try:
            order = Order.objects.get(id=value)
            if order.is_fiscal_locked:
                raise serializers.ValidationError(
                    "Cannot create credit note for a locked fiscal invoice."
                )
            return value
        except Order.DoesNotExist:
            raise serializers.ValidationError("Order not found.")
    
    def validate_credit_amount(self, value):
        if value <= 0:
            raise serializers.ValidationError("Credit amount must be greater than 0.")
        return value


class CreateDebitNoteSerializer(serializers.Serializer):
    """Serializer for creating a Debit Note"""
    original_order_id = serializers.UUIDField()
    description = serializers.CharField(max_length=1000)
    additional_amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    vat_amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    
    def validate_original_order_id(self, value):
        try:
            order = Order.objects.get(id=value)
            if order.is_fiscal_locked:
                raise serializers.ValidationError(
                    "Cannot create debit note for a locked fiscal invoice."
                )
            return value
        except Order.DoesNotExist:
            raise serializers.ValidationError("Order not found.")
    
    def validate_additional_amount(self, value):
        if value <= 0:
            raise serializers.ValidationError("Additional amount must be greater than 0.")
        return value


class CreateVoidTransactionSerializer(serializers.Serializer):
    """Serializer for creating a Void Transaction"""
    original_order_id = serializers.UUIDField()
    void_reason = serializers.ChoiceField(choices=VoidTransaction.VOID_REASON_CHOICES)
    reason_description = serializers.CharField(max_length=1000)
    
    def validate_original_order_id(self, value):
        try:
            order = Order.objects.get(id=value)
            if order.is_fiscal_locked:
                raise serializers.ValidationError(
                    "Cannot void a locked fiscal invoice."
                )
            return value
        except Order.DoesNotExist:
            raise serializers.ValidationError("Order not found.")
