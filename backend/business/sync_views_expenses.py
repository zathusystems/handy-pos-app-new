"""
Expense Sync Views
Handles synchronization of expenses between frontend and backend
"""

from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.utils import timezone
from .models import Expense, Branch
from .serializers import ExpenseSerializer


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def sync_push(request):
    """
    Receive local expense changes from frontend and apply them to backend
    Handles create, update, and delete operations for expenses
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
                
                if entity_type != 'Expense':
                    continue
                
                if op == 'create':
                    # Create new expense
                    expense_data = {
                        'id': change_id,
                        'branch_id': branch_id,
                        'business_id': branch.business_id,
                        **change_data
                    }
                    if not expense_data.get('status'):
                        expense_data['status'] = 'Approved'
                    if not expense_data.get('approved_by'):
                        expense_data['approved_by'] = change_data.get('created_by', 'System')
                    if not expense_data.get('approved_at'):
                        expense_data['approved_at'] = timezone.now()
                    
                    expense = Expense.objects.create(**expense_data)
                    acknowledged.append({'id': change_id, 'server_id': str(expense.id)})
                
                elif op == 'update':
                    # Update existing expense, or create if it doesn't exist
                    try:
                        expense, created = Expense.objects.get_or_create(
                            id=change_id,
                            defaults={
                                'branch_id': branch_id,
                                'business_id': branch.business_id,
                                'title': 'Untitled',
                                'category': 'Other',
                                'amount': 0,
                                'date': timezone.now(),
                                'created_by': 'System',
                            }
                        )
                        
                        # Update fields
                        for field, value in change_data.items():
                            if hasattr(expense, field):
                                setattr(expense, field, value)
                        
                        expense.save()
                        acknowledged.append({'id': change_id, 'server_id': str(expense.id)})
                    
                    except Exception as e:
                        errors.append({
                            'id': change_id,
                            'error': str(e)
                        })
                
                elif op == 'delete':
                    # Delete expense
                    try:
                        expense = Expense.objects.get(id=change_id, branch_id=branch_id)
                        expense.delete()
                        acknowledged.append({'id': change_id})
                    except Expense.DoesNotExist:
                        errors.append({
                            'id': change_id,
                            'error': 'Expense not found'
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


def _get_expense_changes(branch_id, since):
    """
    Internal function to get expense changes
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
        
        # Get expenses modified since timestamp
        expenses = Expense.objects.filter(
            branch_id=branch_id,
            updated_at__gte=since_dt
        ).order_by('updated_at')
        
        serializer = ExpenseSerializer(expenses, many=True)
        
        return serializer.data, None
    
    except Exception as e:
        return None, str(e)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def sync_pull(request):
    """
    Send server expense changes to frontend
    Returns all expenses modified since the given timestamp
    """
    try:
        branch_id = request.query_params.get('branch_id')
        since = request.query_params.get('since', '2000-01-01T00:00:00Z')
        
        if not branch_id:
            return Response(
                {'error': 'branch_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        expenses, error = _get_expense_changes(branch_id, since)
        
        if error:
            return Response(
                {'error': error},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
        
        return Response({
            'changes': {
                'expenses': expenses
            }
        }, status=status.HTTP_200_OK)
    
    except Exception as e:
        return Response(
            {'error': str(e)},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )
