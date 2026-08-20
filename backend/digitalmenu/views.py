from rest_framework import viewsets, permissions, status, serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from .models import Menu, MenuConfig, MenuOption, MenuOptionGroup
from .serializers import (
    MenuOptionGroupSerializer,
    MenuOptionSerializer,
    MenuSerializer,
    MenuConfigSerializer,
)
from .utils import get_business_currency, sync_menu_config_currency


class IsBusinessOwner(permissions.BasePermission):
    """Permission to check if user owns the business"""
    def has_object_permission(self, request, view, obj):
        return obj.business.owner == request.user


def get_accessible_business_ids(user):
    """Businesses owned by the user or assigned through an active staff profile."""
    if not user or not user.is_authenticated:
        return []

    business_ids = list(user.businesses.values_list('id', flat=True))
    try:
        from staff.models import Staff
        staff = Staff.objects.filter(user=user, is_active=True).first()
        if staff and staff.business_id:
            business_ids.append(staff.business_id)
    except Exception:
        pass

    return list(dict.fromkeys(business_ids))


def user_can_access_business(user, business_id):
    return business_id in get_accessible_business_ids(user)


class MenuViewSet(viewsets.ModelViewSet):
    """ViewSet for managing menu items (which inventory items are on the menu)"""
    serializer_class = MenuSerializer
    permission_classes = [permissions.IsAuthenticated, IsBusinessOwner]

    def get_queryset(self):
        """Filter menu items to only those belonging to the current user's business"""
        return Menu.objects.filter(
            business_id__in=get_accessible_business_ids(self.request.user)
        ).select_related('inventory_item', 'branch')

    def perform_create(self, serializer):
        """Save menu item"""
        serializer.save()

    @action(detail=False, methods=['get'])
    def by_branch(self, request):
        """Get all menu items for a specific branch"""
        branch_id = request.query_params.get('branch_id')
        if not branch_id:
            return Response(
                {'error': 'branch_id query parameter is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        menu_items = self.get_queryset().filter(branch_id=branch_id)
        serializer = self.get_serializer(menu_items, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['post'])
    def add_item(self, request):
        """Add an inventory item to the menu for a branch"""
        try:
            from business.models import Business, Branch
            
            branch_id = request.data.get('branch_id')
            inventory_item_id = request.data.get('inventory_item_id')
            
            if not branch_id or not inventory_item_id:
                return Response(
                    {'error': 'branch_id and inventory_item_id are required'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Verify branch belongs to this business
            try:
                branch = Branch.objects.select_related('business').get(
                    id=branch_id,
                    business_id__in=get_accessible_business_ids(request.user),
                )
                business = branch.business
            except Branch.DoesNotExist:
                return Response(
                    {'error': f'Branch {branch_id} not found'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Get or create menu item
            menu_item, created = Menu.objects.get_or_create(
                business=business,
                branch=branch,
                inventory_item_id=inventory_item_id,
                defaults={'is_visible': True}
            )
            if not created and not menu_item.is_visible:
                menu_item.is_visible = True
                menu_item.save(update_fields=['is_visible', 'updated_at'])
            
            serializer = self.get_serializer(menu_item)
            return Response(
                serializer.data,
                status=status.HTTP_201_CREATED if created else status.HTTP_200_OK
            )
        
        except Exception as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )

    @action(detail=False, methods=['post'])
    def create_prepared_item(self, request):
        """Create a menu-only prepared item whose recipe consumes inventory ingredients."""
        try:
            from business.models import Business, Branch

            branch_id = request.data.get('branch_id')
            if not branch_id:
                return Response(
                    {'error': 'branch_id is required'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            try:
                branch = Branch.objects.select_related('business').get(
                    id=branch_id,
                    business_id__in=get_accessible_business_ids(request.user),
                )
                business = branch.business
            except Branch.DoesNotExist:
                return Response(
                    {'error': f'Branch {branch_id} not found'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            serializer = self.get_serializer(data={
                'business': business.id,
                'branch': branch.id,
                'name': request.data.get('name'),
                'category': request.data.get('category', ''),
                'description': request.data.get('description', ''),
                'price': request.data.get('price', 0),
                'image': request.data.get('image') or '',
                'recipe': request.data.get('recipe') or [],
                'is_prepared_item': True,
                'is_visible': request.data.get('is_visible', True),
            })
            serializer.is_valid(raise_exception=True)
            menu_item = serializer.save(business=business, branch=branch, is_prepared_item=True)
            return Response(self.get_serializer(menu_item).data, status=status.HTTP_201_CREATED)

        except serializers.ValidationError as exc:
            return Response(exc.detail, status=status.HTTP_400_BAD_REQUEST)
        except Exception as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )

    @action(detail=False, methods=['post'])
    def set_visibility(self, request):
        """Show or hide an inventory item on the public menu without deleting it"""
        try:
            branch_id = request.data.get('branch_id')
            inventory_item_id = request.data.get('inventory_item_id')
            is_visible = request.data.get('is_visible')

            menu_item_id = request.data.get('menu_item_id')

            if not branch_id or (not inventory_item_id and not menu_item_id):
                return Response(
                    {'error': 'branch_id and inventory_item_id or menu_item_id are required'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            if is_visible is None:
                return Response(
                    {'error': 'is_visible is required'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            if isinstance(is_visible, str):
                is_visible = is_visible.strip().lower() in ('true', '1', 'yes', 'on')
            else:
                is_visible = bool(is_visible)

            lookup = {
                'branch_id': branch_id,
                'business_id__in': get_accessible_business_ids(request.user),
            }
            if menu_item_id:
                lookup['id'] = menu_item_id
            else:
                lookup['inventory_item_id'] = inventory_item_id

            menu_item = Menu.objects.get(**lookup)
            menu_item.is_visible = is_visible
            menu_item.save(update_fields=['is_visible', 'updated_at'])

            serializer = self.get_serializer(menu_item)
            return Response(serializer.data, status=status.HTTP_200_OK)

        except Menu.DoesNotExist:
            return Response(
                {'error': 'Menu item not found'},
                status=status.HTTP_404_NOT_FOUND
            )
        except Exception as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )

    @action(detail=False, methods=['post'])
    def remove_item(self, request):
        """Hide an inventory item from the public menu for a branch"""
        try:
            branch_id = request.data.get('branch_id')
            inventory_item_id = request.data.get('inventory_item_id')
            
            if not branch_id or not inventory_item_id:
                return Response(
                    {'error': 'branch_id and inventory_item_id are required'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            menu_item = Menu.objects.get(
                branch_id=branch_id,
                inventory_item_id=inventory_item_id,
                business_id__in=get_accessible_business_ids(request.user)
            )
            menu_item.is_visible = False
            menu_item.save(update_fields=['is_visible', 'updated_at'])
            
            serializer = self.get_serializer(menu_item)
            return Response(serializer.data, status=status.HTTP_200_OK)
        
        except Menu.DoesNotExist:
            return Response(
                {'error': 'Menu item not found'},
                status=status.HTTP_404_NOT_FOUND
            )
        except Exception as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )


class MenuOptionGroupViewSet(viewsets.ModelViewSet):
    """Manage option/side groups for menu items."""
    serializer_class = MenuOptionGroupSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = MenuOptionGroup.objects.filter(
            menu__business_id__in=get_accessible_business_ids(self.request.user)
        ).select_related(
            'menu',
            'menu__inventory_item',
        ).prefetch_related('options')
        menu_id = self.request.query_params.get('menu_id')
        if menu_id:
            queryset = queryset.filter(menu_id=menu_id)
        return queryset

    def perform_create(self, serializer):
        menu = serializer.validated_data.get('menu')
        if not user_can_access_business(self.request.user, menu.business_id):
            raise serializers.ValidationError({'menu': 'Menu item not found for this business.'})
        serializer.save()

    def perform_update(self, serializer):
        menu = serializer.validated_data.get('menu') or serializer.instance.menu
        if not user_can_access_business(self.request.user, menu.business_id):
            raise serializers.ValidationError({'menu': 'Menu item not found for this business.'})
        serializer.save()


class MenuOptionViewSet(viewsets.ModelViewSet):
    """Manage selectable menu options/sides and their recipe consumption."""
    serializer_class = MenuOptionSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        queryset = MenuOption.objects.filter(
            group__menu__business_id__in=get_accessible_business_ids(self.request.user)
        ).select_related('group', 'group__menu', 'linked_inventory_item')
        group_id = self.request.query_params.get('group_id')
        if group_id:
            queryset = queryset.filter(group_id=group_id)
        return queryset

    def perform_create(self, serializer):
        group = serializer.validated_data.get('group')
        linked_inventory_item = serializer.validated_data.get('linked_inventory_item')
        if not user_can_access_business(self.request.user, group.menu.business_id):
            raise serializers.ValidationError({'group': 'Option group not found for this business.'})
        if linked_inventory_item and linked_inventory_item.business_id != group.menu.business_id:
            raise serializers.ValidationError({
                'linked_inventory_item': 'Linked stock item must belong to this business.'
            })
        serializer.save()

    def perform_update(self, serializer):
        group = serializer.validated_data.get('group') or serializer.instance.group
        linked_inventory_item = serializer.validated_data.get(
            'linked_inventory_item',
            serializer.instance.linked_inventory_item,
        )
        if not user_can_access_business(self.request.user, group.menu.business_id):
            raise serializers.ValidationError({'group': 'Option group not found for this business.'})
        if linked_inventory_item and linked_inventory_item.business_id != group.menu.business_id:
            raise serializers.ValidationError({
                'linked_inventory_item': 'Linked stock item must belong to this business.'
            })
        serializer.save()


class MenuConfigViewSet(viewsets.ModelViewSet):
    """ViewSet for managing digital menu configuration per branch"""
    serializer_class = MenuConfigSerializer
    permission_classes = [permissions.IsAuthenticated, IsBusinessOwner]

    def get_queryset(self):
        """Filter menu configs to only those belonging to the current user's business"""
        return MenuConfig.objects.filter(business__owner=self.request.user)

    def create(self, request, *args, **kwargs):
        """Create or update menu config"""
        try:
            from business.models import Business, Branch
            
            print(f"[MenuConfig] Create request received")
            print(f"[MenuConfig] Request data: {request.data}")
            
            # Get business from authenticated user
            try:
                business = Business.objects.get(owner=request.user)
                print(f"[MenuConfig] Found business: {business.id}")
            except Business.DoesNotExist:
                print(f"[MenuConfig] No business found for user {request.user}")
                return Response(
                    {'error': 'User does not have an associated business'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Get branch from request data
            branch_id = request.data.get('branch')
            print(f"[MenuConfig] Branch ID: {branch_id}")
            
            if not branch_id:
                return Response(
                    {'error': 'branch is required'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Verify branch belongs to this business
            try:
                branch = Branch.objects.get(id=branch_id, business=business)
                print(f"[MenuConfig] Found branch: {branch.id}")
            except Branch.DoesNotExist:
                print(f"[MenuConfig] Branch {branch_id} not found for business {business.id}")
                return Response(
                    {'error': f'Branch {branch_id} not found'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Get or create config
            config, created = MenuConfig.objects.get_or_create(
                business=business,
                branch=branch
            )
            sync_menu_config_currency(config)
            
            print(f"[MenuConfig] Config {'created' if created else 'retrieved'}: {config.id}")
            
            # Update with request data
            serializer = self.get_serializer(config, data=request.data, partial=True)
            serializer.is_valid(raise_exception=True)
            config = serializer.save()
            sync_menu_config_currency(config)
            
            print(f"[MenuConfig] Config saved successfully")
            return Response(serializer.data, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)
        
        except Exception as e:
            print(f"[MenuConfig] Error: {str(e)}")
            import traceback
            traceback.print_exc()
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )

    def perform_create(self, serializer):
        """Auto-populate business from authenticated user"""
        from business.models import Business
        
        try:
            business = Business.objects.get(owner=self.request.user)
        except Business.DoesNotExist:
            raise serializers.ValidationError('User must have a business')
        
        config = serializer.save(business=business)
        sync_menu_config_currency(config)

    def perform_update(self, serializer):
        """Save menu config update"""
        config = serializer.save()
        sync_menu_config_currency(config)

    @action(detail=False, methods=['get'], permission_classes=[])
    def public(self, request):
        """Get menu config for a specific branch - PUBLIC ENDPOINT (no auth required)"""
        branch_id = request.query_params.get('branch_id')
        
        if not branch_id:
            return Response(
                {'error': 'branch_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        try:
            from business.models import Branch
            
            # Get branch
            branch = Branch.objects.get(id=branch_id)
            business_currency = get_business_currency(branch.business)
            
            # Get existing config or return defaults
            config, created = MenuConfig.objects.get_or_create(
                business=branch.business,
                branch=branch,
                defaults={
                    'display_name': 'Our Menu',
                    'description': 'Welcome to our restaurant',
                    'tagline': 'Fresh & Delicious',
                    'footer_text': 'Thank you for your visit!',
                    'primary_color': '#263b57',
                    'accent_color': '#236dd5',
                    'theme': 'auto',
                    'items_per_row': '3',
                    'currency': business_currency,
                    'show_prices': True,
                    'show_categories': True,
                    'show_images': True,
                    'show_brand_info': True,
                    'show_contact_info': True,
                    'enable_search': True,
                    'enable_filters': True,
                    'enable_sorting': True,
                    'accept_orders': True,
                }
            )
            sync_menu_config_currency(config)
            
            print(f"[MenuConfig] Retrieved public config for branch {branch_id}: created={created}")
            serializer = self.get_serializer(config)
            return Response(serializer.data)
        
        except Exception as e:
            print(f"[MenuConfig] Error: {str(e)}")
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )

    @action(detail=False, methods=['get', 'post'])
    def by_branch(self, request):
        """Get or create menu config for a specific branch"""
        branch_id = request.query_params.get('branch_id') or request.data.get('branch_id')
        
        if not branch_id:
            return Response(
                {'error': 'branch_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        try:
            from business.models import Business, Branch
            
            # Get business from authenticated user
            business = Business.objects.get(owner=request.user)
            business_currency = get_business_currency(business)
            
            # Verify branch belongs to this business
            branch = Branch.objects.get(id=branch_id, business=business)
            
            if request.method == 'GET':
                # Get existing config or return defaults
                config, created = MenuConfig.objects.get_or_create(
                    business=business,
                    branch=branch,
                    defaults={
                        'display_name': 'Our Menu',
                        'description': 'Welcome to our restaurant',
                        'tagline': 'Fresh & Delicious',
                        'footer_text': 'Thank you for your visit!',
                        'primary_color': '#263b57',
                        'accent_color': '#236dd5',
                        'theme': 'auto',
                        'items_per_row': '3',
                        'currency': business_currency,
                        'show_prices': True,
                        'show_categories': True,
                        'show_images': True,
                        'show_brand_info': True,
                        'show_contact_info': True,
                        'enable_search': True,
                        'enable_filters': True,
                        'enable_sorting': True,
                        'accept_orders': True,
                    }
                )
                sync_menu_config_currency(config)
                
                print(f"[MenuConfig] Retrieved config for branch {branch_id}: created={created}")
                serializer = self.get_serializer(config)
                return Response(serializer.data)
            
            elif request.method == 'POST':
                # Update or create config
                config, created = MenuConfig.objects.get_or_create(
                    business=business,
                    branch=branch
                )
                
                serializer = self.get_serializer(config, data=request.data, partial=True)
                serializer.is_valid(raise_exception=True)
                config = serializer.save()
                sync_menu_config_currency(config)
                
                print(f"[MenuConfig] Updated config for branch {branch_id}")
                return Response(serializer.data, status=status.HTTP_200_OK)
        
        except Exception as e:
            print(f"[MenuConfig] Error: {str(e)}")
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )
