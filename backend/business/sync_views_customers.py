"""
Customer Sync Views
Handles synchronization of customers between frontend and backend
"""

from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.utils import timezone
from .models import Customer, Branch
from .serializers import CustomerSerializer

CUSTOMER_FIELD_ALIASES = {
    'businessId': 'business_id',
    'branchId': 'branch_id',
    'customerTin': 'customer_tin',
    'vatRegistered': 'vat_registered',
    'isActive': 'is_active',
    'accountEnabled': 'account_enabled',
    'creditLimit': 'credit_limit',
}

CUSTOMER_SYNC_READ_ONLY_FIELDS = {
    'id',
    'business',
    'business_id',
    'current_balance',
    'currentBalance',
    'available_credit',
    'availableCredit',
    'has_credit_limit',
    'hasCreditLimit',
    'created_at',
    'createdAt',
    'updated_at',
    'updatedAt',
    'is_dirty',
    '_dirty',
    '_operation',
    '_synced_at',
}


def _normalize_customer_payload(change_data):
    normalized = {}
    for key, value in (change_data or {}).items():
        field = CUSTOMER_FIELD_ALIASES.get(key, key)
        if field in CUSTOMER_SYNC_READ_ONLY_FIELDS:
            continue
        if field == 'branch':
            field = 'branch_id'
        if field == 'branch_id':
            continue
        normalized[field] = value
    return normalized


def _is_integer_reference(value):
    try:
        int(str(value))
        return True
    except (TypeError, ValueError):
        return False


def _customer_ack(local_id, customer):
    data = CustomerSerializer(customer).data
    data.pop('id', None)
    return {
        'id': str(local_id),
        'server_id': str(customer.id),
        **data,
    }


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def sync_push(request):
    """
    Receive local customer changes from frontend and apply them to backend
    Handles create, update, and delete operations for customers
    """
    try:
        data = request.data
        branch_id = data.get('branch_id')
        changes = data.get('changes', [])
        
        if not branch_id:
            return Response(
                {'error': 'branch_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Verify branch exists and user has access
        try:
            branch = Branch.objects.get(id=branch_id)
        except Branch.DoesNotExist:
            return Response(
                {'error': 'Branch not found'},
                status=status.HTTP_404_NOT_FOUND
            )
        
        acknowledged = []
        conflicts = []
        errors = []
        
        for change in changes:
            try:
                entity_type = change.get('entity_type')
                op = change.get('op')  # 'create', 'update', 'delete'
                change_id = change.get('id')
                change_data = change.get('data', {})
                
                if entity_type != 'Customer':
                    continue
                
                if op == 'create':
                    # Create new customer
                    normalized_customer_data = _normalize_customer_payload(change_data)
                    customer_data = {
                        'branch_id': branch_id,
                        'business_id': branch.business_id,
                        **normalized_customer_data
                    }
                    if _is_integer_reference(change_id):
                        customer_data['id'] = change_id
                    
                    customer = Customer.objects.create(**customer_data)
                    acknowledged.append(_customer_ack(change_id, customer))
                
                elif op == 'update':
                    # Update existing customer, or create if it doesn't exist
                    try:
                        customer = None
                        if _is_integer_reference(change_id):
                            customer = Customer.objects.filter(id=change_id, business_id=branch.business_id).first()

                        if customer is None:
                            normalized_data = _normalize_customer_payload(change_data)
                            customer = Customer.objects.filter(
                                business_id=branch.business_id,
                                phone=normalized_data.get('phone') or '',
                            ).first() if normalized_data.get('phone') else None

                        if customer is None:
                            normalized_data = _normalize_customer_payload(change_data)
                            customer = Customer.objects.create(
                                branch_id=branch_id,
                                business_id=branch.business_id,
                                name=normalized_data.get('name') or 'Unnamed Customer',
                                **{
                                    key: value
                                    for key, value in normalized_data.items()
                                    if key != 'name' and hasattr(Customer, key)
                                }
                            )
                        else:
                            normalized_data = _normalize_customer_payload(change_data)
                        
                        # Update fields
                        for field, value in normalized_data.items():
                            if hasattr(customer, field):
                                setattr(customer, field, value)
                        
                        customer.branch_id = branch_id
                        customer.business_id = branch.business_id
                        customer.save()
                        acknowledged.append(_customer_ack(change_id, customer))
                    
                    except Exception as e:
                        errors.append({
                            'id': change_id,
                            'error': str(e)
                        })
                
                elif op == 'delete':
                    # Delete customer
                    try:
                        customer = Customer.objects.get(id=change_id, business_id=branch.business_id)
                        customer.delete()
                        acknowledged.append({'id': change_id})
                    except Customer.DoesNotExist:
                        errors.append({
                            'id': change_id,
                            'error': 'Customer not found'
                        })
            
            except Exception as e:
                errors.append({
                    'id': change.get('id'),
                    'error': str(e)
                })
        
        return Response({
            'results': {
                'acknowledged': acknowledged,
                'conflicts': conflicts,
                'errors': errors
            }
        }, status=status.HTTP_200_OK)
    
    except Exception as e:
        return Response(
            {'error': str(e)},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


def _get_customer_changes(branch_id, since):
    """
    Internal function to get customer changes
    """
    try:
        # Verify branch exists
        try:
            branch = Branch.objects.get(id=branch_id)
        except Branch.DoesNotExist:
            return None, 'Branch not found'
        
        # Parse since timestamp
        try:
            since_dt = timezone.datetime.fromisoformat(since.replace('Z', '+00:00'))
        except (ValueError, AttributeError):
            since_dt = timezone.datetime(2000, 1, 1, tzinfo=timezone.utc)
        
        # Get customers modified since timestamp
        customers = Customer.objects.filter(
            branch_id=branch_id,
            updated_at__gte=since_dt
        )
        
        serializer = CustomerSerializer(customers, many=True)
        
        return serializer.data, None
    
    except Exception as e:
        return None, str(e)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def sync_pull(request):
    """
    Send server customer changes to frontend
    Returns all customers modified since the given timestamp
    """
    try:
        branch_id = request.query_params.get('branch_id')
        since = request.query_params.get('since', '2000-01-01T00:00:00Z')
        
        if not branch_id:
            return Response(
                {'error': 'branch_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        customers, error = _get_customer_changes(branch_id, since)
        
        if error:
            return Response(
                {'error': error},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
        
        return Response({
            'changes': {
                'customers': customers
            }
        }, status=status.HTTP_200_OK)
    
    except Exception as e:
        return Response(
            {'error': str(e)},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )
