"""
Custom middleware for Tauri desktop app
"""

class DisableCSRFForAPIMiddleware:
    """Disable CSRF for API endpoints"""
    
    def __init__(self, get_response):
        self.get_response = get_response
    
    def __call__(self, request):
        # Disable CSRF for /api/ endpoints
        if request.path.startswith('/api/'):
            request.csrf_processing_done = True
            print(f"[CSRF MIDDLEWARE] Disabled CSRF for {request.path}")
        
        response = self.get_response(request)
        return response
