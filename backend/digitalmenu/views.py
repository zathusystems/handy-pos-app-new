from rest_framework import viewsets, permissions, status, serializers
from rest_framework.decorators import action
from rest_framework.response import Response
from decimal import Decimal, InvalidOperation
from django.db import IntegrityError, transaction
from django.db.models import Q

from .models import Menu, MenuConfig, MenuOption, MenuOptionGroup, MenuOptionGroupMenu
from .serializers import (
    MenuOptionGroupSerializer,
    MenuOptionSerializer,
    MenuSerializer,
    MenuConfigSerializer,
)
from .utils import (
    OPTION_OVERRIDE_FIELDS,
    get_business_currency,
    option_assignment_for_menu,
    option_snapshot,
    sync_menu_config_currency,
)


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
        """Create a produced sellable inventory item and place it on the menu."""
        try:
            from business.models import Business, Branch
            from inventory.models import InventoryItem

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

            name = str(request.data.get('name') or '').strip()
            if not name:
                return Response(
                    {'name': 'Menu item name is required.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            try:
                price = Decimal(str(request.data.get('price') or '0'))
            except (InvalidOperation, TypeError, ValueError):
                return Response(
                    {'price': 'Enter a valid selling price.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if price < 0:
                return Response(
                    {'price': 'Selling price cannot be negative.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            recipe = request.data.get('recipe') or []
            if not isinstance(recipe, list):
                return Response(
                    {'recipe': 'Recipe must be a list of inventory ingredients.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            raw_is_visible = request.data.get('is_visible', True)
            if isinstance(raw_is_visible, str):
                is_visible = raw_is_visible.strip().lower() not in ('false', '0', 'no', 'off')
            else:
                is_visible = bool(raw_is_visible)

            try:
                with transaction.atomic():
                    inventory_item = InventoryItem.objects.create(
                        business=business,
                        branch=branch,
                        name=name,
                        category=str(request.data.get('category') or '').strip(),
                        item_type='sellable',
                        stock_units=Decimal('0.000'),
                        unit_type='unit',
                        reorder_level=Decimal('0.000'),
                        cost=Decimal('0.00'),
                        price=price,
                        is_recipe_ingredient=False,
                        is_produced=True,
                        recipe=recipe,
                        image=request.data.get('image') or None,
                        on_menu=True,
                    )

                    menu_item = Menu.objects.create(
                        business=business,
                        branch=branch,
                        inventory_item=inventory_item,
                        description=str(request.data.get('description') or '').strip(),
                        is_prepared_item=False,
                        is_visible=is_visible,
                    )
            except IntegrityError:
                return Response(
                    {'name': 'A sellable product with this name already exists in this branch.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
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

    @action(detail=False, methods=['post'])
    def delete_item(self, request):
        """Completely delete a menu entry, including its option groups and choices."""
        try:
            branch_id = request.data.get('branch_id')
            inventory_item_id = request.data.get('inventory_item_id')
            menu_item_id = request.data.get('menu_item_id')

            if not branch_id or (not inventory_item_id and not menu_item_id):
                return Response(
                    {'error': 'branch_id and inventory_item_id or menu_item_id are required'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            lookup = {
                'branch_id': branch_id,
                'business_id__in': get_accessible_business_ids(request.user),
            }
            if menu_item_id:
                lookup['id'] = menu_item_id
            else:
                lookup['inventory_item_id'] = inventory_item_id

            menu_item = Menu.objects.get(**lookup)
            deleted_name = menu_item.display_name
            menu_item.delete()

            return Response(
                {
                    'deleted': True,
                    'name': deleted_name,
                    'menu_item_id': str(menu_item_id or ''),
                    'inventory_item_id': str(inventory_item_id or ''),
                },
                status=status.HTTP_200_OK,
            )

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

    @action(detail=False, methods=['patch', 'post'])
    def update_item(self, request):
        """Update a menu item. Prepared items update Menu; inventory-backed items update InventoryItem."""
        try:
            from inventory.models import InventoryItem

            branch_id = request.data.get('branch_id')
            inventory_item_id = request.data.get('inventory_item_id')
            menu_item_id = request.data.get('menu_item_id')

            if not branch_id or (not inventory_item_id and not menu_item_id):
                return Response(
                    {'error': 'branch_id and inventory_item_id or menu_item_id are required'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            lookup = {
                'branch_id': branch_id,
                'business_id__in': get_accessible_business_ids(request.user),
            }
            if menu_item_id:
                lookup['id'] = menu_item_id
            else:
                lookup['inventory_item_id'] = inventory_item_id

            menu_item = Menu.objects.select_related('inventory_item').get(**lookup)
            is_visible = request.data.get('is_visible', None)
            if is_visible is not None:
                if isinstance(is_visible, str):
                    is_visible = is_visible.strip().lower() in ('true', '1', 'yes', 'on')
                else:
                    is_visible = bool(is_visible)
                menu_item.is_visible = is_visible
                menu_item.save(update_fields=['is_visible', 'updated_at'])

            editable_fields = ('name', 'category', 'description', 'price', 'image', 'recipe')
            has_editable_payload = any(field in request.data for field in editable_fields)

            if menu_item.inventory_item_id:
                inventory_item = InventoryItem.objects.get(
                    id=menu_item.inventory_item_id,
                    branch_id=branch_id,
                    business_id__in=get_accessible_business_ids(request.user),
                )
                menu_update_fields = []
                if 'description' in request.data:
                    menu_item.description = request.data.get('description') or ''
                    menu_update_fields.extend(['description', 'updated_at'])

                if menu_update_fields:
                    menu_item.save(update_fields=list(dict.fromkeys(menu_update_fields)))

                update_fields = []
                for field in ('name', 'category', 'image', 'recipe'):
                    if field in request.data:
                        setattr(inventory_item, field, request.data.get(field) or (None if field == 'image' else ''))
                        update_fields.append(field)

                if 'price' in request.data:
                    try:
                        inventory_item.price = Decimal(str(request.data.get('price') or 0))
                    except (InvalidOperation, TypeError, ValueError):
                        return Response({'price': 'Enter a valid price.'}, status=status.HTTP_400_BAD_REQUEST)
                    update_fields.append('price')

                if has_editable_payload:
                    update_fields.append('updated_at')
                    inventory_item.save(update_fields=list(dict.fromkeys(update_fields)))

                menu_item.refresh_from_db()
                return Response(self.get_serializer(menu_item).data, status=status.HTTP_200_OK)

            data = {}
            for field in editable_fields:
                if field in request.data:
                    data[field] = request.data.get(field)
            if 'is_visible' in request.data:
                data['is_visible'] = is_visible

            serializer = self.get_serializer(menu_item, data=data, partial=True)
            serializer.is_valid(raise_exception=True)
            serializer.save(is_prepared_item=True)
            return Response(serializer.data, status=status.HTTP_200_OK)

        except Menu.DoesNotExist:
            return Response(
                {'error': 'Menu item not found'},
                status=status.HTTP_404_NOT_FOUND
            )
        except InventoryItem.DoesNotExist:
            return Response(
                {'error': 'Inventory item not found'},
                status=status.HTTP_404_NOT_FOUND
            )
        except serializers.ValidationError as exc:
            return Response(exc.detail, status=status.HTTP_400_BAD_REQUEST)
        except Exception as e:
            return Response(
                {'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )


class MenuOptionGroupViewSet(viewsets.ModelViewSet):
    """Manage item-specific and reusable option/side groups."""
    serializer_class = MenuOptionGroupSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_serializer_context(self):
        context = super().get_serializer_context()
        menu_id = self.request.query_params.get('menu_id')
        if menu_id:
            context['menu'] = Menu.objects.filter(id=menu_id).first()
        return context

    def get_queryset(self):
        queryset = MenuOptionGroup.objects.filter(
            Q(menu__business_id__in=get_accessible_business_ids(self.request.user))
            | Q(menu_assignments__menu__business_id__in=get_accessible_business_ids(self.request.user))
        ).select_related(
            'menu',
            'menu__inventory_item',
        ).prefetch_related('options', 'menu_assignments').distinct()
        menu_id = self.request.query_params.get('menu_id')
        if menu_id:
            queryset = queryset.filter(
                Q(menu_id=menu_id) | Q(menu_assignments__menu_id=menu_id)
            ).distinct()
        branch_id = self.request.query_params.get('branch_id')
        if branch_id:
            queryset = queryset.filter(menu__branch_id=branch_id)
        if self.request.query_params.get('shared_only', '').lower() in {'1', 'true', 'yes'}:
            queryset = queryset.filter(is_shared=True)
        return queryset

    def perform_create(self, serializer):
        menu = serializer.validated_data.get('menu')
        if not user_can_access_business(self.request.user, menu.business_id):
            raise serializers.ValidationError({'menu': 'Menu item not found for this business.'})
        group = serializer.save()
        MenuOptionGroupMenu.objects.get_or_create(group=group, menu=menu)

    def perform_update(self, serializer):
        menu = serializer.validated_data.get('menu') or serializer.instance.menu
        if not user_can_access_business(self.request.user, menu.business_id):
            raise serializers.ValidationError({'menu': 'Menu item not found for this business.'})
        group = serializer.save()
        MenuOptionGroupMenu.objects.get_or_create(group=group, menu=menu)

    @action(detail=True, methods=['post'])
    def attach(self, request, pk=None):
        """Attach a shared choice set to another menu item in the same branch."""
        group = self.get_object()
        if not group.is_shared:
            return Response(
                {'error': 'Mark this choice set as reusable before attaching it.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        menu_id = request.data.get('menu') or request.data.get('menu_id')
        if not menu_id:
            return Response(
                {'error': 'menu is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        menu = Menu.objects.filter(
            id=menu_id,
            business_id__in=get_accessible_business_ids(request.user),
        ).first()
        if not menu:
            return Response(
                {'error': 'Menu item not found for this business.'},
                status=status.HTTP_404_NOT_FOUND,
            )
        if group.menu_id and group.menu.branch_id != menu.branch_id:
            return Response(
                {'error': 'Choice sets can only be reused within the same branch.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        MenuOptionGroupMenu.objects.get_or_create(group=group, menu=menu)
        group.refresh_from_db()
        return Response(
            self.get_serializer(group, context={**self.get_serializer_context(), 'menu': menu}).data,
            status=status.HTTP_200_OK,
        )

    @action(detail=True, methods=['post'])
    def detach(self, request, pk=None):
        """Remove a shared choice set from one menu item without deleting it."""
        group = self.get_object()
        menu_id = request.data.get('menu') or request.data.get('menu_id')
        if not menu_id:
            return Response(
                {'error': 'menu is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if str(group.menu_id) == str(menu_id):
            return Response(
                {'error': 'The owner menu cannot be detached. Delete the choice set if it is no longer needed.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        deleted, _ = MenuOptionGroupMenu.objects.filter(
            group=group,
            menu_id=menu_id,
        ).delete()
        if not deleted:
            return Response(
                {'error': 'This choice set is not attached to that menu item.'},
                status=status.HTTP_404_NOT_FOUND,
            )
        group.refresh_from_db()
        menu = Menu.objects.filter(id=menu_id).first()
        return Response(
            self.get_serializer(group, context={**self.get_serializer_context(), 'menu': menu}).data,
            status=status.HTTP_200_OK,
        )


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

    def _get_item_assignment(self, option, menu_id):
        menu = Menu.objects.filter(
            id=menu_id,
            business_id__in=get_accessible_business_ids(self.request.user),
        ).first()
        if not menu:
            raise serializers.ValidationError({'menu': 'Menu item not found for this business.'})
        if option.group.menu.branch_id != menu.branch_id:
            raise serializers.ValidationError({
                'menu': 'This choice can only be customized within its branch.'
            })

        assignment = option_assignment_for_menu(option.group, menu)
        if not assignment:
            raise serializers.ValidationError({
                'menu': 'This choice set is not attached to that menu item.'
            })
        return menu, assignment

    @staticmethod
    def _snapshot_with_validated_values(option, current_values, validated_data):
        snapshot = dict(current_values or option_snapshot(option))
        for field in OPTION_OVERRIDE_FIELDS:
            if field not in validated_data:
                continue
            value = validated_data[field]
            if field == 'linked_inventory_item':
                value = str(value.pk) if value else None
            elif field in {'price_delta', 'price_override', 'linked_inventory_quantity'}:
                value = str(value) if value is not None else None
            snapshot[field] = value
        return snapshot

    @action(detail=True, methods=['post'], url_path='customize-for-item')
    def customize_for_item(self, request, pk=None):
        """Save an option snapshot for one menu item without changing its source."""
        option = self.get_object()
        menu_id = request.data.get('menu') or request.data.get('menu_id')
        if not menu_id:
            return Response({'menu': 'menu is required.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            menu, assignment = self._get_item_assignment(option, menu_id)
        except serializers.ValidationError as exc:
            return Response(exc.detail, status=status.HTTP_400_BAD_REQUEST)

        payload = request.data.copy()
        payload.pop('menu', None)
        payload.pop('menu_id', None)
        payload.pop('group', None)
        serializer = self.get_serializer(option, data=payload, partial=True)
        serializer.is_valid(raise_exception=True)
        linked_inventory_item = serializer.validated_data.get(
            'linked_inventory_item',
            option.linked_inventory_item,
        )
        if linked_inventory_item and linked_inventory_item.business_id != option.group.menu.business_id:
            return Response(
                {'linked_inventory_item': 'Linked stock item must belong to this business.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        overrides = dict(assignment.option_overrides or {})
        source_id = str(option.id)
        current_values = overrides.get(source_id) if isinstance(overrides.get(source_id), dict) else None
        overrides[source_id] = self._snapshot_with_validated_values(
            option,
            current_values,
            serializer.validated_data,
        )
        excluded_ids = [
            str(value)
            for value in (assignment.excluded_option_ids or [])
            if str(value) != source_id
        ]
        assignment.excluded_option_ids = excluded_ids
        assignment.option_overrides = overrides
        assignment.save(update_fields=['excluded_option_ids', 'option_overrides'])

        return Response(
            self._resolved_option_response(option, menu),
            status=status.HTTP_200_OK,
        )

    @action(detail=True, methods=['post'], url_path='remove-from-item')
    def remove_from_item(self, request, pk=None):
        """Hide a shared option from one menu item without deleting the source."""
        option = self.get_object()
        menu_id = request.data.get('menu') or request.data.get('menu_id')
        if not menu_id:
            return Response({'menu': 'menu is required.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            menu, assignment = self._get_item_assignment(option, menu_id)
        except serializers.ValidationError as exc:
            return Response(exc.detail, status=status.HTTP_400_BAD_REQUEST)

        source_id = str(option.id)
        excluded_ids = {str(value) for value in (assignment.excluded_option_ids or [])}
        excluded_ids.add(source_id)
        assignment.excluded_option_ids = sorted(excluded_ids)
        assignment.save(update_fields=['excluded_option_ids'])
        return Response(
            {'id': source_id, 'menu': str(menu.id), 'removed': True},
            status=status.HTTP_200_OK,
        )

    @action(detail=True, methods=['post'], url_path='restore-for-item')
    def restore_for_item(self, request, pk=None):
        """Restore the original shared option for one menu item."""
        option = self.get_object()
        menu_id = request.data.get('menu') or request.data.get('menu_id')
        if not menu_id:
            return Response({'menu': 'menu is required.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            menu, assignment = self._get_item_assignment(option, menu_id)
        except serializers.ValidationError as exc:
            return Response(exc.detail, status=status.HTTP_400_BAD_REQUEST)

        source_id = str(option.id)
        assignment.excluded_option_ids = [
            str(value)
            for value in (assignment.excluded_option_ids or [])
            if str(value) != source_id
        ]
        overrides = dict(assignment.option_overrides or {})
        overrides.pop(source_id, None)
        assignment.option_overrides = overrides
        assignment.save(update_fields=['excluded_option_ids', 'option_overrides'])
        return Response(
            self._resolved_option_response(option, menu),
            status=status.HTTP_200_OK,
        )

    def _resolved_option_response(self, option, menu):
        from .serializers import MenuOptionGroupSerializer

        group_data = MenuOptionGroupSerializer(
            option.group,
            context={**self.get_serializer_context(), 'menu': menu},
        ).data
        return next(
            (row for row in group_data.get('options', []) if str(row.get('id')) == str(option.id)),
            {'id': str(option.id)},
        )

    def destroy(self, request, *args, **kwargs):
        """Delete a source option only as an explicit global operation."""
        option = self.get_object()
        group = option.group
        attached_menu_ids = {str(group.menu_id)}
        attached_menu_ids.update(
            str(menu_id) for menu_id in group.menu_assignments.values_list('menu_id', flat=True)
        )
        is_global_source = group.is_shared or len(attached_menu_ids) > 1
        confirmed = str(request.query_params.get('confirm_global', '')).lower() in {
            '1', 'true', 'yes',
        }
        if is_global_source and not confirmed:
            return Response(
                {
                    'error': 'This deletes the choice from every menu item using the shared choice set.',
                    'requires_confirmation': True,
                    'attached_menu_count': len(attached_menu_ids),
                },
                status=status.HTTP_409_CONFLICT,
            )
        source_id = str(option.id)
        with transaction.atomic():
            for assignment in group.menu_assignments.all():
                excluded_ids = [
                    str(value)
                    for value in (assignment.excluded_option_ids or [])
                    if str(value) != source_id
                ]
                overrides = dict(assignment.option_overrides or {})
                overrides.pop(source_id, None)
                assignment.excluded_option_ids = excluded_ids
                assignment.option_overrides = overrides
                assignment.save(update_fields=['excluded_option_ids', 'option_overrides'])
            return super().destroy(request, *args, **kwargs)


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
                    'takeaway_enabled': False,
                    'takeaway_packaging_price': 0,
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
