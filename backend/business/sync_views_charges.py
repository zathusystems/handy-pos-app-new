"""
Business charge sync views.

Handles offline sync for additional charges such as levies and service charges.
"""

from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.utils import timezone

from .models import Business, BusinessCharge
from .serializers import BusinessChargeSerializer


def _process_charge_changes(business_id, changes):
    try:
        business = Business.objects.get(id=business_id)
    except Business.DoesNotExist:
        return [], [{'error': f'Business {business_id} not found'}]

    acknowledged = []
    errors = []

    for change in changes:
        try:
            entity_id = change.get('id')
            operation = change.get('op')
            change_data = change.get('data', {})
            change_data.pop('businessId', None)

            if operation == 'create':
                change_data['business'] = business.id
                serializer = BusinessChargeSerializer(data=change_data)
                if serializer.is_valid():
                    serializer.save(business=business)
                    acknowledged.append({'id': entity_id})
                else:
                    errors.append({'id': entity_id, 'error': serializer.errors})

            elif operation == 'update':
                try:
                    charge = BusinessCharge.objects.get(id=entity_id, business=business)
                except BusinessCharge.DoesNotExist:
                    errors.append({'id': entity_id, 'error': 'Charge not found'})
                    continue

                serializer = BusinessChargeSerializer(charge, data=change_data, partial=True)
                if serializer.is_valid():
                    serializer.save()
                    acknowledged.append({'id': entity_id})
                else:
                    errors.append({'id': entity_id, 'error': serializer.errors})

            elif operation == 'delete':
                try:
                    charge = BusinessCharge.objects.get(id=entity_id, business=business)
                    charge.delete()
                    acknowledged.append({'id': entity_id})
                except BusinessCharge.DoesNotExist:
                    errors.append({'id': entity_id, 'error': 'Charge not found'})

            else:
                errors.append({'id': entity_id, 'error': f'Unknown operation: {operation}'})

        except Exception as exc:
            errors.append({'id': change.get('id'), 'error': str(exc)})

    return acknowledged, errors


def _get_charge_changes(business_id, since):
    try:
        try:
            business = Business.objects.get(id=business_id)
        except Business.DoesNotExist:
            return [], f"Business {business_id} not found"

        try:
            since_dt = timezone.datetime.fromisoformat(since.replace('Z', '+00:00'))
        except Exception:
            since_dt = timezone.datetime(2000, 1, 1, tzinfo=timezone.utc)

        charges = BusinessCharge.objects.filter(
            business=business,
            updated_at__gte=since_dt,
        ).order_by('updated_at')

        serializer = BusinessChargeSerializer(charges, many=True)
        return serializer.data, None
    except Exception as exc:
        return [], str(exc)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def sync_push(request):
    business_id = request.data.get('business_id')
    if not business_id:
        return Response({'error': 'business_id is required'}, status=status.HTTP_400_BAD_REQUEST)

    acknowledged, errors = _process_charge_changes(business_id, request.data.get('changes', []))
    return Response({'results': {'acknowledged': acknowledged, 'errors': errors}}, status=status.HTTP_200_OK)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def sync_pull(request):
    business_id = request.query_params.get('business_id')
    since = request.query_params.get('since', '2000-01-01T00:00:00Z')
    if not business_id:
        return Response({'error': 'business_id is required'}, status=status.HTTP_400_BAD_REQUEST)

    charges, error = _get_charge_changes(business_id, since)
    if error:
        return Response({'error': error}, status=status.HTTP_400_BAD_REQUEST)
    return Response({'changes': {'charges': charges}}, status=status.HTTP_200_OK)


__all__ = ['sync_push', 'sync_pull', '_get_charge_changes', '_process_charge_changes']
