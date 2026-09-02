"""
Business App Sync Views
Aggregates sync views for all business-related entities
"""

from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.utils import timezone
from .access import get_accessible_business_ids
from .models import Branch
from .sync_views_invoices import sync_push as invoice_sync_push, sync_pull as invoice_sync_pull, _get_invoice_changes
from .sync_views_expenses import sync_push as expense_sync_push, sync_pull as expense_sync_pull, _get_expense_changes
from .sync_views_customers import sync_push as customer_sync_push, sync_pull as customer_sync_pull, _get_customer_changes
from .sync_views_taxes import sync_push as tax_sync_push, sync_pull as tax_sync_pull, _get_tax_changes
from .sync_views_charges import _get_charge_changes, _process_charge_changes


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def sync_push(request):
    """
    Main sync push endpoint that routes to appropriate handlers
    """
    try:
        data = request.data
        changes = data.get('changes', [])
        branch_id = data.get('branch_id')
        business_id = data.get('business_id')
        accessible_business_ids = get_accessible_business_ids(request.user)

        # Sync payloads may identify a business directly (business-level
        # entities) or through a branch. Validate either reference before
        # forwarding changes to the entity handlers.
        if business_id and str(business_id) not in {str(value) for value in accessible_business_ids}:
            return Response(
                {'error': 'Business is not available for this account'},
                status=status.HTTP_403_FORBIDDEN,
            )

        if branch_id:
            branch = Branch.objects.filter(
                id=branch_id,
                business_id__in=accessible_business_ids,
            ).first()
            if not branch:
                return Response(
                    {'error': 'Branch is not available for this account'},
                    status=status.HTTP_403_FORBIDDEN,
                )
            business_id = business_id or branch.business_id

        if not business_id:
            return Response(
                {'error': 'business_id or branch_id is required'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        
        # Separate changes by entity type
        invoice_changes = [c for c in changes if c.get('entity_type') == 'Invoice']
        expense_changes = [c for c in changes if c.get('entity_type') == 'Expense']
        customer_changes = [c for c in changes if c.get('entity_type') == 'Customer']
        tax_changes = [c for c in changes if c.get('entity_type') == 'TaxRate']
        charge_changes = [c for c in changes if c.get('entity_type') == 'BusinessCharge']
        
        all_results = {
            'acknowledged': [],
            'conflicts': [],
            'errors': []
        }
        
        # Process invoices
        if invoice_changes:
            request.data['changes'] = invoice_changes
            invoice_response = invoice_sync_push(request)
            if invoice_response.status_code == 200:
                invoice_results = invoice_response.data.get('results', {})
                all_results['acknowledged'].extend(invoice_results.get('acknowledged', []))
                all_results['conflicts'].extend(invoice_results.get('conflicts', []))
                all_results['errors'].extend(invoice_results.get('errors', []))
        
        # Process expenses
        if expense_changes:
            request.data['changes'] = expense_changes
            expense_response = expense_sync_push(request)
            if expense_response.status_code == 200:
                expense_results = expense_response.data.get('results', {})
                all_results['acknowledged'].extend(expense_results.get('acknowledged', []))
                all_results['conflicts'].extend(expense_results.get('conflicts', []))
                all_results['errors'].extend(expense_results.get('errors', []))
        
        # Process customers
        if customer_changes:
            request.data['changes'] = customer_changes
            customer_response = customer_sync_push(request)
            if customer_response.status_code == 200:
                customer_results = customer_response.data.get('results', {})
                all_results['acknowledged'].extend(customer_results.get('acknowledged', []))
                all_results['conflicts'].extend(customer_results.get('conflicts', []))
                all_results['errors'].extend(customer_results.get('errors', []))
        
        # Process tax rates
        # Tax rates are business-level, so we need to get business_id from request
        if tax_changes:
            try:
                print(f'[Sync] Processing tax changes with business_id: {business_id}')
                
                if not business_id:
                    # Try to get from branch_id if business_id not provided
                    if branch_id:
                        business_id = branch.business_id
                        print(f'[Sync] Got business_id from branch: {business_id}')
                
                if business_id:
                    # Process tax changes directly instead of calling sync_push
                    from .sync_views_taxes import _process_tax_changes
                    print(f'[Sync] Calling _process_tax_changes with business_id: {business_id}')
                    acknowledged, errors = _process_tax_changes(business_id, tax_changes)
                    print(f'[Sync] Tax changes processed: {len(acknowledged)} acknowledged, {len(errors)} errors')
                    all_results['acknowledged'].extend(acknowledged)
                    all_results['errors'].extend(errors)
                else:
                    print(f'[Sync] No business_id or branch_id found in request')
                    all_results['errors'].append({
                        'error': 'business_id or branch_id is required for tax rate sync'
                    })
            except Exception as e:
                print(f'[Sync] Error processing tax rates: {e}')
                import traceback
                traceback.print_exc()
                all_results['errors'].append({
                    'error': f'Tax rate sync failed: {str(e)}'
                })

        if charge_changes:
            try:
                if not business_id:
                    if branch_id:
                        business_id = branch.business_id

                if business_id:
                    acknowledged, errors = _process_charge_changes(business_id, charge_changes)
                    all_results['acknowledged'].extend(acknowledged)
                    all_results['errors'].extend(errors)
                else:
                    all_results['errors'].append({
                        'error': 'business_id or branch_id is required for charge sync'
                    })
            except Exception as e:
                all_results['errors'].append({
                    'error': f'Charge sync failed: {str(e)}'
                })
        
        return Response({
            'results': all_results
        }, status=status.HTTP_200_OK)
    
    except Exception as e:
        return Response(
            {'error': str(e)},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def sync_pull(request):
    """
    Main sync pull endpoint that aggregates changes from all entities
    """
    try:
        branch_id = request.query_params.get('branch_id')
        since = request.query_params.get('since', '2000-01-01T00:00:00Z')
        
        if not branch_id:
            return Response(
                {'error': 'branch_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        branch = Branch.objects.filter(
            id=branch_id,
            business_id__in=get_accessible_business_ids(request.user),
        ).first()
        if not branch:
            return Response(
                {'error': 'Branch is not available for this account'},
                status=status.HTTP_403_FORBIDDEN,
            )
        
        all_changes = {}
        
        # Pull invoices using internal helper
        try:
            invoices, error = _get_invoice_changes(branch_id, since)
            if error:
                print(f'[Sync] Error pulling invoices: {error}')
            else:
                all_changes['invoices'] = invoices
        except Exception as e:
            print(f'[Sync] Error pulling invoices: {e}')
        
        # Pull expenses using internal helper
        try:
            expenses, error = _get_expense_changes(branch_id, since)
            if error:
                print(f'[Sync] Error pulling expenses: {error}')
            else:
                all_changes['expenses'] = expenses
        except Exception as e:
            print(f'[Sync] Error pulling expenses: {e}')
        
        # Pull customers using internal helper
        try:
            customers, error = _get_customer_changes(branch_id, since)
            if error:
                print(f'[Sync] Error pulling customers: {error}')
            else:
                all_changes['customers'] = customers
        except Exception as e:
            print(f'[Sync] Error pulling customers: {e}')
        
        # Pull tax rates using internal helper
        # Tax rates are business-level, so we need to get business_id from branch
        try:
            business_id = branch.business_id
            tax_rates, error = _get_tax_changes(business_id, since)
            if error:
                print(f'[Sync] Error pulling tax rates: {error}')
            else:
                all_changes['tax_rates'] = tax_rates
        except Exception as e:
            print(f'[Sync] Error pulling tax rates: {e}')

        try:
            charges, error = _get_charge_changes(branch.business_id, since)
            if error:
                print(f'[Sync] Error pulling charges: {error}')
            else:
                all_changes['charges'] = charges
        except Exception as e:
            print(f'[Sync] Error pulling charges: {e}')
        
        return Response({
            'changes': all_changes
        }, status=status.HTTP_200_OK)
    
    except Exception as e:
        return Response(
            {'error': str(e)},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


__all__ = ['sync_push', 'sync_pull']
