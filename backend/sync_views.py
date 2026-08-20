"""
Standalone API endpoints for cloud sync

Can be included in any app's URLs
"""

from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.conf import settings
from sync_service import sync_all_to_cloud, get_sync_status


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def sync_to_cloud(request):
    """
    Sync all dirty records from all apps to cloud backend
    
    POST /api/sync-to-cloud/
    
    Optional body:
    {
        "cloud_url": "http://custom-cloud.com:8001"
    }
    """
    cloud_url = request.data.get('cloud_url') or getattr(settings, 'CLOUD_BACKEND_URL', None)
    
    if not cloud_url:
        return Response({
            'status': 'error',
            'message': 'Cloud URL not configured'
        }, status=400)
    
    results = sync_all_to_cloud(cloud_url)
    
    return Response({
        'status': 'success',
        'message': f"Synced {results['total_synced']} records, {results['total_failed']} failed",
        'results': results
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def sync_status(request):
    """
    Get current sync status across all apps
    
    GET /api/sync-status/
    """
    cloud_url = getattr(settings, 'CLOUD_BACKEND_URL', None)
    status = get_sync_status(cloud_url)
    
    return Response({
        'status': 'success',
        'data': status
    })
