"""
Health check endpoint for Tauri backend verification
"""
from rest_framework.decorators import api_view
from rest_framework.response import Response
from django.db import connection
from django.db.utils import OperationalError


@api_view(['GET'])
def health_check(request):
    """
    Health check endpoint for Tauri to verify backend is running.
    
    Returns:
        - 200 OK if database is accessible
        - 503 Service Unavailable if database is down
    """
    try:
        # Test database connection
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        
        return Response({
            'status': 'healthy',
            'database': 'connected',
        })
    except OperationalError as e:
        return Response({
            'status': 'unhealthy',
            'database': 'disconnected',
            'error': str(e),
        }, status=503)
