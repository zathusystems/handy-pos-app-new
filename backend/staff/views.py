from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from django.core.exceptions import PermissionDenied
from .models import Staff, StaffRole
from .serializers import StaffSerializer, StaffCreateSerializer, StaffUpdateSerializer
from subscription.feature_access import SubscriptionFeatureGateMixin


class IsBusinessOwner(permissions.BasePermission):
    """Permission to check if user is the business owner"""
    def has_permission(self, request, view):
        return request.user and request.user.is_authenticated

    def has_object_permission(self, request, view, obj):
        return obj.business.owner == request.user


class IsAdminOrBusinessOwner(permissions.BasePermission):
    """Permission to check if user is Admin staff or business owner"""
    def has_permission(self, request, view):
        return request.user and request.user.is_authenticated

    def has_object_permission(self, request, view, obj):
        # Business owner has full access
        if obj.business.owner == request.user:
            return True
        
        # Check if user is an Admin staff member in the same business
        try:
            user_staff = Staff.objects.get(user=request.user, business=obj.business)
            return user_staff.role == StaffRole.ADMIN
        except Staff.DoesNotExist:
            return False


class StaffViewSet(SubscriptionFeatureGateMixin, viewsets.ModelViewSet):
    serializer_class = StaffSerializer
    permission_classes = [permissions.IsAuthenticated]
    required_subscription_feature = 'staff_management'
    feature_gate_allow_staff_access = True
    feature_gate_exempt_actions = {'me', 'permissions'}

    def get_queryset(self):
        """Get staff based on user role"""
        user = self.request.user
        
        # Business owners see all staff in their businesses
        if hasattr(user, 'businesses'):
            owner_queryset = Staff.objects.filter(business__owner=user)
        else:
            owner_queryset = Staff.objects.none()
        
        # Admin staff see staff in their business
        try:
            user_staff = Staff.objects.get(user=user)
            if user_staff.role == StaffRole.ADMIN:
                admin_queryset = Staff.objects.filter(business=user_staff.business)
                return owner_queryset | admin_queryset
        except Staff.DoesNotExist:
            pass
        
        # Managers and operational staff can only see themselves
        try:
            user_staff = Staff.objects.get(user=user)
            if user_staff.role in [StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER, StaffRole.KITCHEN_STAFF]:
                return Staff.objects.filter(id=user_staff.id)
        except Staff.DoesNotExist:
            pass
        
        return owner_queryset

    def get_serializer_class(self):
        if self.action == 'create':
            return StaffCreateSerializer
        elif self.action in ['update', 'partial_update']:
            return StaffUpdateSerializer
        return StaffSerializer

    def check_staff_permissions(self, action_type):
        """Check if user has permission to perform staff actions"""
        user = self.request.user
        
        # Business owners can do everything
        if hasattr(user, 'businesses') and user.businesses.exists():
            return True
        
        # Check user's staff role
        try:
            user_staff = Staff.objects.get(user=user)
            
            if action_type == 'create':
                # Only Admin can create staff
                return user_staff.role == StaffRole.ADMIN
            elif action_type == 'update':
                # Admin can update, Managers/Cashiers can only update themselves
                if user_staff.role == StaffRole.ADMIN:
                    return True
                # Allow self-update for profile changes
                return True
            elif action_type == 'delete':
                # Only Admin can delete staff
                return user_staff.role == StaffRole.ADMIN
            elif action_type == 'list':
                # All authenticated users can list (filtered by get_queryset)
                return True
            elif action_type == 'retrieve':
                # All authenticated users can retrieve (filtered by get_queryset)
                return True
        except Staff.DoesNotExist:
            pass
        
        return False

    def create(self, request, *args, **kwargs):
        """Create staff with role-based access control"""
        if not self.check_staff_permissions('create'):
            return Response(
                {'error': 'You do not have permission to create staff members. Only Admins can create staff.'},
                status=status.HTTP_403_FORBIDDEN
            )
        return super().create(request, *args, **kwargs)

    def update(self, request, *args, **kwargs):
        """Update staff with role-based access control"""
        if not self.check_staff_permissions('update'):
            return Response(
                {'error': 'You do not have permission to update this staff member.'},
                status=status.HTTP_403_FORBIDDEN
            )

        instance = self.get_object()
        is_business_owner = instance.business.owner_id == request.user.id
        requester_staff = None

        if not is_business_owner:
            requester_staff = Staff.objects.filter(
                user=request.user,
                business=instance.business,
                is_active=True,
            ).first()

            if not requester_staff:
                return Response(
                    {'error': 'You do not have permission to update this staff member.'},
                    status=status.HTTP_403_FORBIDDEN
                )

        # Non-admin staff can only update their own basic profile details.
        if requester_staff and requester_staff.role != StaffRole.ADMIN and instance.id != requester_staff.id:
            return Response(
                {'error': 'You can only update your own profile.'},
                status=status.HTTP_403_FORBIDDEN
            )

        if requester_staff and requester_staff.role != StaffRole.ADMIN:
            restricted_fields = {
                'role',
                'branch',
                'is_active',
                'assigned_product_type',
                'is_fuel_attendant',
            }
            attempted_restricted_fields = sorted(
                field_name for field_name in restricted_fields if field_name in request.data
            )
            if attempted_restricted_fields:
                return Response(
                    {'error': 'You do not have permission to change role, branch, or staff status.'},
                    status=status.HTTP_403_FORBIDDEN
                )

        return super().update(request, *args, **kwargs)

    def destroy(self, request, *args, **kwargs):
        """Delete staff with role-based access control"""
        if not self.check_staff_permissions('delete'):
            return Response(
                {'error': 'You do not have permission to delete staff members. Only Admins can delete staff.'},
                status=status.HTTP_403_FORBIDDEN
            )
        return super().destroy(request, *args, **kwargs)

    def perform_create(self, serializer):
        serializer.save()

    def perform_update(self, serializer):
        serializer.save()

    @action(detail=False, methods=['get'])
    def me(self, request):
        """Get current user's staff profile"""
        try:
            staff = Staff.objects.get(user=request.user)
            serializer = self.get_serializer(staff)
            return Response(serializer.data)
        except Staff.DoesNotExist:
            return Response(
                {'error': 'Staff profile not found for this user'},
                status=status.HTTP_404_NOT_FOUND
            )

    @action(detail=False, methods=['get'])
    def permissions(self, request):
        """Get current user's permissions based on their role"""
        try:
            staff = Staff.objects.get(user=request.user)
            
            permissions_map = {
                StaffRole.ADMIN: {
                    'can_manage_staff': True,
                    'can_manage_inventory': True,
                    'can_manage_sales': True,
                    'can_manage_customers': True,
                    'can_manage_invoices': True,
                    'can_view_reports': True,
                    'can_manage_settings': True,
                    'can_view_kitchen': True,
                },
                StaffRole.MANAGER: {
                    'can_manage_staff': False,
                    'can_manage_inventory': True,
                    'can_manage_sales': True,
                    'can_manage_customers': True,
                    'can_manage_invoices': True,
                    'can_view_reports': True,
                    'can_manage_settings': False,
                    'can_view_kitchen': True,
                },
                StaffRole.CASHIER: {
                    'can_manage_staff': False,
                    'can_manage_inventory': False,
                    'can_manage_sales': True,
                    'can_manage_customers': False,
                    'can_manage_invoices': False,
                    'can_view_reports': False,
                    'can_manage_settings': False,
                    'can_view_kitchen': True,
                },
                StaffRole.WAITER: {
                    'can_manage_staff': False,
                    'can_manage_inventory': False,
                    'can_manage_sales': True,
                    'can_manage_customers': True,
                    'can_manage_invoices': False,
                    'can_view_reports': False,
                    'can_manage_settings': False,
                    'can_view_kitchen': True,
                },
                StaffRole.KITCHEN_STAFF: {
                    'can_manage_staff': False,
                    'can_manage_inventory': False,
                    'can_manage_sales': False,
                    'can_manage_customers': False,
                    'can_manage_invoices': False,
                    'can_view_reports': False,
                    'can_manage_settings': False,
                    'can_view_kitchen': True,
                },
            }
            
            user_permissions = permissions_map.get(staff.role, {})
            
            return Response({
                'role': staff.role,
                'permissions': user_permissions,
                'business_id': staff.business.id,
                'branch_id': staff.branch.id if staff.branch else None,
            })
        except Staff.DoesNotExist:
            # Business owner has all permissions
            if hasattr(request.user, 'businesses') and request.user.businesses.exists():
                return Response({
                    'role': 'Owner',
                    'permissions': {
                        'can_manage_staff': True,
                        'can_manage_inventory': True,
                        'can_manage_sales': True,
                        'can_manage_customers': True,
                        'can_manage_invoices': True,
                        'can_view_reports': True,
                        'can_manage_settings': True,
                        'can_view_kitchen': True,
                    },
                    'business_id': request.user.businesses.first().id,
                    'branch_id': None,
                })
            
            return Response(
                {'error': 'User profile not found'},
                status=status.HTTP_404_NOT_FOUND
            )
