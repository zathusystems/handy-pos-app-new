"""
Invoice Sync Views
Handles synchronization of invoices between frontend and backend
"""

from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.utils import timezone
from .models import Invoice, Customer, Branch
from .serializers import InvoiceSerializer, InvoiceCreateSerializer


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def sync_push(request):
    """
    Receive local invoice changes from frontend and apply them to backend
    Handles create, update, and delete operations for invoices
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
                
                if entity_type != 'Invoice':
                    continue
                
                if op == 'create':
                    # Create new invoice
                    invoice_data = {
                        'id': change_id,
                        'branch_id': branch_id,
                        'business_id': branch.business_id,
                        **change_data
                    }
                    
                    # Get next invoice number if not provided
                    if 'invoice_number' not in invoice_data:
                        last_invoice = Invoice.objects.filter(
                            business_id=branch.business_id
                        ).order_by('-invoice_number').first()
                        invoice_data['invoice_number'] = (last_invoice.invoice_number + 1) if last_invoice else 1
                    
                    # Handle customer relationship
                    customer_id = invoice_data.pop('customer_id', None)
                    if customer_id:
                        try:
                            customer = Customer.objects.get(id=customer_id, business_id=branch.business_id)
                            invoice_data['customer_id'] = customer.id
                        except Customer.DoesNotExist:
                            # Customer doesn't exist, proceed without it
                            pass
                    
                    invoice = Invoice.objects.create(**invoice_data)
                    acknowledged.append({'id': change_id, 'server_id': str(invoice.id)})
                
                elif op == 'update':
                    # Update existing invoice, or create if it doesn't exist
                    try:
                        invoice, created = Invoice.objects.get_or_create(
                            id=change_id,
                            defaults={
                                'branch_id': branch_id,
                                'business_id': branch.business_id,
                                'invoice_number': 1,
                                'customer_name': 'Unknown',
                                'status': 'Draft',
                            }
                        )
                        
                        # Update fields
                        for field, value in change_data.items():
                            if field == 'customer_id':
                                # Handle customer relationship
                                try:
                                    customer = Customer.objects.get(id=value, business_id=branch.business_id)
                                    setattr(invoice, 'customer_id', customer.id)
                                except Customer.DoesNotExist:
                                    pass
                            elif hasattr(invoice, field):
                                setattr(invoice, field, value)
                        
                        # If invoice_number wasn't provided and this is a new invoice, generate it
                        if created and 'invoice_number' not in change_data:
                            last_invoice = Invoice.objects.filter(
                                business_id=branch.business_id
                            ).exclude(id=change_id).order_by('-invoice_number').first()
                            invoice.invoice_number = (last_invoice.invoice_number + 1) if last_invoice else 1
                        
                        invoice.save()
                        acknowledged.append({'id': change_id, 'server_id': str(invoice.id)})
                    
                    except Exception as e:
                        errors.append({
                            'id': change_id,
                            'error': str(e)
                        })
                
                elif op == 'delete':
                    # Delete invoice
                    try:
                        invoice = Invoice.objects.get(id=change_id, branch_id=branch_id)
                        invoice.delete()
                        acknowledged.append({'id': change_id})
                    except Invoice.DoesNotExist:
                        errors.append({
                            'id': change_id,
                            'error': 'Invoice not found'
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


def _get_invoice_changes(branch_id, since):
    """
    Internal function to get invoice changes
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
        
        # Get invoices modified since timestamp
        invoices = Invoice.objects.filter(
            branch_id=branch_id,
            updated_at__gte=since_dt
        ).select_related('customer')
        
        serializer = InvoiceSerializer(invoices, many=True)
        
        return serializer.data, None
    
    except Exception as e:
        return None, str(e)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def sync_pull(request):
    """
    Send server invoice changes to frontend
    Returns all invoices modified since the given timestamp
    """
    try:
        branch_id = request.query_params.get('branch_id')
        since = request.query_params.get('since', '2000-01-01T00:00:00Z')
        
        if not branch_id:
            return Response(
                {'error': 'branch_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        invoices, error = _get_invoice_changes(branch_id, since)
        
        if error:
            return Response(
                {'error': error},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
        
        return Response({
            'changes': {
                'invoices': invoices
            }
        }, status=status.HTTP_200_OK)
    
    except Exception as e:
        return Response(
            {'error': str(e)},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )
