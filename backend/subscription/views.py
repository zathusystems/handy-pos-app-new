from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
from django.db import transaction
from django.db.utils import OperationalError
from django.db.models import Q
from django.utils import timezone
from datetime import timedelta
from .models import Subscription, Invoice, Deposit, DepositStatus, SubscriptionFeature, FeaturePricing
from system_config.models import SystemConfig
from business.models import Business
from business.access import get_accessible_business
import logging
from .serializers import (
    SubscriptionSerializer, InvoiceSerializer, DepositSerializer, 
    DepositCreateSerializer, SubscriptionFeatureSerializer, FeaturePricingSerializer,
    SubscriptionUpdateSerializer,
)

logger = logging.getLogger(__name__)

TRIAL_FEATURE_LOCK_MESSAGE = (
    'Features cannot be disabled while free trial credits are active. '
    'Added credits stay on your balance and you can remove features after the trial ends.'
)


class DepositPagination(PageNumberPagination):
    page_size = 10
    page_size_query_param = 'page_size'
    max_page_size = 50

class SubscriptionViewSet(viewsets.ModelViewSet):
    serializer_class = SubscriptionSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        # Keep subscription visibility aligned with the business access rules.
        # Superusers may support any business from the admin account; ordinary
        # users may see their owned businesses and active staff assignments.
        return self._get_accessible_subscription_queryset(
            self.request,
            allow_staff_access=True,
            admin_staff_only=self.request.method not in permissions.SAFE_METHODS,
        )

    def get_serializer_class(self):
        if self.action in {'update', 'partial_update'}:
            return SubscriptionUpdateSerializer
        return SubscriptionSerializer

    def perform_update(self, serializer):
        previous_staff_management_enabled = bool(
            getattr(serializer.instance, 'enable_staff_management', False)
        )
        subscription = serializer.save()
        subscription.sync_feature_assignments_from_flags()
        if previous_staff_management_enabled and not subscription.enable_staff_management:
            subscription.handle_disabled_feature_side_effects('staff_management')
        elif not previous_staff_management_enabled and subscription.enable_staff_management:
            subscription.handle_enabled_feature_side_effects('staff_management')

    def _get_active_staff_business_id(self, request):
        try:
            from staff.models import Staff
        except Exception:
            return None

        staff_profile = Staff.objects.filter(
            user=request.user,
            is_active=True,
        ).only('business_id').first()
        return staff_profile.business_id if staff_profile else None

    @classmethod
    def _get_accessible_subscription_queryset(
        cls,
        request,
        allow_staff_access=False,
        admin_staff_only=False,
    ):
        user = request.user
        if getattr(user, 'is_superuser', False):
            return Subscription.objects.all().order_by('id')

        access_filter = Q(business__owner=user)
        if allow_staff_access:
            try:
                from staff.models import Staff, StaffRole

                staff_profiles = Staff.objects.filter(
                    user=user,
                    is_active=True,
                )
                if admin_staff_only:
                    staff_profiles = staff_profiles.filter(role=StaffRole.ADMIN)
                staff_business_ids = staff_profiles.values_list('business_id', flat=True)
                access_filter |= Q(business_id__in=staff_business_ids)
            except Exception:
                pass

        return Subscription.objects.filter(access_filter).order_by('id').distinct()

    def _resolve_subscription(
        self,
        request,
        allow_staff_access=False,
        admin_staff_only=False,
    ):
        business_id = request.data.get('business') or request.query_params.get('business')
        subscriptions = self._get_accessible_subscription_queryset(
            request,
            allow_staff_access=allow_staff_access,
            admin_staff_only=admin_staff_only,
        )
        if business_id:
            subscriptions = subscriptions.filter(business_id=business_id)
        return subscriptions.first()

    def _resolve_owned_business(self, request):
        business_id = request.data.get('business') or request.query_params.get('business')
        if not business_id:
            return None, Response(
                {'detail': 'business ID is required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            business = get_accessible_business(
                request.user,
                business_id,
                admin_staff_only=True,
            )
            if not business:
                raise Business.DoesNotExist
        except Business.DoesNotExist:
            return None, Response(
                {'detail': 'Business not found or not available for this account'},
                status=status.HTTP_403_FORBIDDEN
            )

        return business, None

    @staticmethod
    def _coerce_bool(value, default=True):
        if value is None:
            return default
        if isinstance(value, (list, tuple)):
            value = value[-1] if value else None
            if value is None:
                return default
        if isinstance(value, bool):
            return value
        normalized = str(value).strip().lower()
        if normalized in {'1', 'true', 'yes', 'y', 'on'}:
            return True
        if normalized in {'0', 'false', 'no', 'n', 'off'}:
            return False
        return default

    @staticmethod
    def _business_supports_kitchen(business):
        business_type = str(getattr(business, 'business_type', '') or '').strip().lower()
        return business_type in {'restaurant', 'bar_liquor'}

    def _get_selected_feature_flags(self, business, data=None):
        selected_flags = {}
        data = data or {}
        supports_kitchen = self._business_supports_kitchen(business)

        for feature_name, flag_field in Subscription.FEATURE_FLAG_FIELDS.items():
            if feature_name == 'kitchen' and not supports_kitchen:
                selected_flags[feature_name] = False
                continue

            default = True
            selected_flags[feature_name] = self._coerce_bool(data.get(flag_field), default)

        return selected_flags

    def _calculate_trial_credit_details(self, business, selected_feature_flags=None):
        config = SystemConfig.get_config()
        selected_feature_flags = selected_feature_flags or self._get_selected_feature_flags(business)

        business_country = (getattr(business, 'country', '') or '').strip().lower()
        is_malawi = business_country in {'malawi', 'mw', 'mwi'} or 'malawi' in business_country
        currency_code = (
            config.malawi_currency_code
            if is_malawi
            else config.international_currency_code
        )

        base_price = (
            config.base_subscription_price_per_day_mwk
            if currency_code == config.malawi_currency_code
            else config.base_subscription_price_per_day_usd
        )

        free_trial_days = int(getattr(config, 'trial_days', 14) or 0)
        total_daily_charge = base_price
        active_feature_count = 0

        if config.enable_feature_pricing:
            feature_pricings = FeaturePricing.objects.filter(is_active=True)
            for feature_pricing in feature_pricings:
                if selected_feature_flags.get(feature_pricing.feature, True):
                    active_feature_count += 1
                    total_daily_charge += feature_pricing.price_per_day or 0

        free_trial_credits = total_daily_charge * free_trial_days
        free_trial_end_date = timezone.now() + timedelta(days=free_trial_days)

        return {
            'currency_code': currency_code,
            'base_price_per_day': base_price,
            'total_daily_charge': total_daily_charge,
            'free_trial_days': free_trial_days,
            'free_trial_credits_amount': free_trial_credits,
            'free_trial_end_date': free_trial_end_date,
            'active_feature_count': active_feature_count,
            'feature_pricing_enabled': config.enable_feature_pricing,
        }

    @action(detail=False, methods=['get'], url_path='trial-preview')
    def trial_preview(self, request):
        """Preview trial credits for a business before subscription creation."""
        business, error_response = self._resolve_owned_business(request)
        if error_response:
            return error_response

        selected_feature_flags = self._get_selected_feature_flags(business, request.query_params)
        trial_details = self._calculate_trial_credit_details(business, selected_feature_flags)
        return Response({
            'business': business.id,
            'currency_code': trial_details['currency_code'],
            'base_price_per_day': float(trial_details['base_price_per_day']),
            'total_daily_charge': float(trial_details['total_daily_charge']),
            'free_trial_days': trial_details['free_trial_days'],
            'free_trial_credits_amount': float(trial_details['free_trial_credits_amount']),
            'free_trial_end_date': trial_details['free_trial_end_date'].isoformat(),
            'active_feature_count': trial_details['active_feature_count'],
            'feature_pricing_enabled': trial_details['feature_pricing_enabled'],
        })

    def create(self, request, *args, **kwargs):
        """Create a new subscription with free trial credits"""
        print(f"[SUBSCRIPTION] create() called with data: {request.data}")
        business, error_response = self._resolve_owned_business(request)
        if error_response:
            print("[SUBSCRIPTION] Invalid business in request")
            return error_response

        # Check if subscription already exists for this business
        existing = Subscription.objects.filter(business_id=business.id).first()
        if existing:
            print(f"[SUBSCRIPTION] Subscription already exists for business {business.id}")
            return Response(
                {'detail': f'Subscription for this business already exists (ID: {existing.id})'},
                status=status.HTTP_400_BAD_REQUEST
            )

        data = dict(request.data)
        selected_feature_flags = self._get_selected_feature_flags(business, data)
        trial_details = self._calculate_trial_credit_details(business, selected_feature_flags)
        free_trial_days = trial_details['free_trial_days']
        free_trial_credits = trial_details['free_trial_credits_amount']
        free_trial_end_date = trial_details['free_trial_end_date']
        base_price = trial_details['base_price_per_day']

        # Create a mutable copy of request data with free trial fields
        for feature_name, enabled in selected_feature_flags.items():
            flag_field = Subscription.FEATURE_FLAG_FIELDS.get(feature_name)
            if flag_field:
                data[flag_field] = enabled

        data['status'] = 'active'  # Use 'active' status, not 'trial'
        data['base_price_per_day'] = float(base_price)
        data['account_balance'] = float(free_trial_credits)
        data['free_trial_days'] = free_trial_days
        data['free_trial_credits_applied'] = True
        data['free_trial_credits_amount'] = float(free_trial_credits)
        data['free_trial_end_date'] = free_trial_end_date.isoformat()
        
        print(f"[SUBSCRIPTION] Creating subscription with data: {data}")
        
        # Use the serializer directly with the modified data
        serializer = self.get_serializer(data=data)
        if not serializer.is_valid():
            print(f"[SUBSCRIPTION] Serializer errors: {serializer.errors}")
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        
        with transaction.atomic():
            self.perform_create(serializer)
            serializer.instance.sync_feature_assignments_from_flags()
        headers = self.get_success_headers(serializer.data)
        
        print(f"[SUBSCRIPTION] Created subscription for business '{business.name}' (ID: {business.id})")
        print(f"[SUBSCRIPTION] Free trial credits applied: {free_trial_credits}")
        print(f"[SUBSCRIPTION] Free trial period: {free_trial_days} days (until {free_trial_end_date.strftime('%Y-%m-%d')})")
        print(f"[SUBSCRIPTION] Daily charge: {base_price}")
        print(f"[SUBSCRIPTION] Account balance set to: {free_trial_credits}")
        
        return Response(serializer.data, status=status.HTTP_201_CREATED, headers=headers)
    
    @action(detail=False, methods=['get'])
    def current(self, request):
        """Get the current subscription for the user's accessible business."""
        try:
            subscription = self._resolve_subscription(request, allow_staff_access=True)
            
            if not subscription:
                return Response(
                    {'detail': 'No subscription found'},
                    status=status.HTTP_404_NOT_FOUND
                )

            # Best effort; don't fail GET due to SQLite write-lock races.
            try:
                # Apply missed daily charges on read to keep billing up-to-date
                # even when periodic jobs are delayed.
                charged, message, charged_days, charged_amount = subscription.apply_pending_daily_charges()
                if charged:
                    logger.info(
                        "[SUBSCRIPTION] Catch-up billing applied on current(): business=%s, days=%s, amount=%s",
                        subscription.business_id,
                        charged_days,
                        charged_amount,
                    )
                else:
                    logger.debug("[SUBSCRIPTION] Catch-up billing skipped on current(): %s", message)
                subscription.sync_feature_assignments_from_flags()
            except OperationalError as exc:
                logger.warning("Skipping subscription feature sync on current(): %s", exc)
            except Exception as exc:
                logger.warning("Skipping catch-up billing on current(): %s", exc)
            
            serializer = self.get_serializer(subscription)
            return Response(serializer.data)
        except Exception as e:
            import traceback
            print(f"[SUBSCRIPTION] Error in current endpoint: {str(e)}")
            print(f"[SUBSCRIPTION] Traceback: {traceback.format_exc()}")
            return Response(
                {'detail': f'Error retrieving subscription: {str(e)}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

    @action(detail=False, methods=['post'])
    def pause(self, request):
        """Pause subscription"""
        subscription = self._resolve_subscription(
            request,
            allow_staff_access=True,
            admin_staff_only=True,
        )
        if not subscription:
            return Response(
                {'detail': 'No subscription found'},
                status=status.HTTP_404_NOT_FOUND
            )

        subscription.status = 'paused'
        subscription.save(update_fields=['status', 'updated_at'])
        serializer = self.get_serializer(subscription)
        return Response(serializer.data)

    @action(detail=False, methods=['post'])
    def resume(self, request):
        """Resume subscription"""
        subscription = self._resolve_subscription(
            request,
            allow_staff_access=True,
            admin_staff_only=True,
        )
        if not subscription:
            return Response(
                {'detail': 'No subscription found'},
                status=status.HTTP_404_NOT_FOUND
            )

        subscription.status = 'active'
        subscription.save(update_fields=['status', 'updated_at'])
        serializer = self.get_serializer(subscription)
        return Response(serializer.data)


class InvoiceViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = InvoiceSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        # Subscription invoice flow is disabled in favor of direct daily charging.
        return Invoice.objects.none()


class DepositViewSet(viewsets.ModelViewSet):
    serializer_class = DepositSerializer
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = DepositPagination

    def get_queryset(self):
        # Billing reads must use the same business scope as the current
        # subscription endpoint, including active staff assignments.
        accessible_subscriptions = SubscriptionViewSet._get_accessible_subscription_queryset(
            self.request,
            allow_staff_access=True,
            admin_staff_only=self.request.method not in permissions.SAFE_METHODS,
        )
        queryset = Deposit.objects.filter(subscription__in=accessible_subscriptions)
        business_id = self.request.query_params.get('business')
        if business_id:
            queryset = queryset.filter(subscription__business_id=business_id)
        else:
            first_subscription = accessible_subscriptions.first()
            if first_subscription:
                queryset = queryset.filter(subscription=first_subscription)
        return queryset

    def _resolve_subscription(
        self,
        request,
        allow_staff_access=False,
        admin_staff_only=False,
    ):
        business_id = request.data.get('business') or request.query_params.get('business')
        subscriptions = SubscriptionViewSet._get_accessible_subscription_queryset(
            request,
            allow_staff_access=allow_staff_access,
            admin_staff_only=admin_staff_only,
        )
        if business_id:
            subscriptions = subscriptions.filter(business_id=business_id)
        return subscriptions.first()

    def get_serializer_class(self):
        if self.action == 'create':
            return DepositCreateSerializer
        return DepositSerializer

    def create(self, request, *args, **kwargs):
        """Create a new deposit request"""
        subscription = self._resolve_subscription(
            request,
            allow_staff_access=True,
            admin_staff_only=True,
        )
        if not subscription:
            return Response(
                {'detail': 'No subscription found'},
                status=status.HTTP_404_NOT_FOUND
            )

        serializer = self.get_serializer(
            data=request.data,
            context={'subscription': subscription}
        )
        serializer.is_valid(raise_exception=True)
        deposit = serializer.save()

        return Response(
            DepositSerializer(deposit).data,
            status=status.HTTP_201_CREATED
        )

    def destroy(self, request, *args, **kwargs):
        deposit = self.get_object()
        if deposit.status == DepositStatus.COMPLETED:
            return Response(
                {'detail': 'Completed deposits cannot be deleted.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if deposit.status not in {
            DepositStatus.PENDING,
            DepositStatus.FAILED,
            DepositStatus.CANCELLED,
        }:
            return Response(
                {'detail': f'Deposits with status {deposit.status} cannot be deleted.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        self.perform_destroy(deposit)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=['post'])
    def complete(self, request, pk=None):
        """Complete a deposit and add credits to account"""
        deposit = self.get_object()
        
        if deposit.status != DepositStatus.PENDING:
            return Response(
                {'detail': f'Cannot complete deposit with status {deposit.status}'},
                status=status.HTTP_400_BAD_REQUEST
            )

        if deposit.complete_deposit():
            return Response(
                DepositSerializer(deposit).data,
                status=status.HTTP_200_OK
            )
        
        return Response(
            {'detail': 'Failed to complete deposit'},
            status=status.HTTP_400_BAD_REQUEST
        )

    @action(detail=True, methods=['post'])
    def cancel(self, request, pk=None):
        """Cancel a pending deposit"""
        deposit = self.get_object()
        
        if deposit.cancel_deposit():
            return Response(
                DepositSerializer(deposit).data,
                status=status.HTTP_200_OK
            )
        
        return Response(
            {'detail': 'Cannot cancel deposit with current status'},
            status=status.HTTP_400_BAD_REQUEST
        )

    @action(detail=False, methods=['get'])
    def summary(self, request):
        """Get deposit summary for current user"""
        subscription = self._resolve_subscription(request, allow_staff_access=True)
        if not subscription:
            return Response(
                {'detail': 'No subscription found'},
                status=status.HTTP_404_NOT_FOUND
            )

        deposits = self.get_queryset().filter(subscription=subscription)
        
        summary = {
            'total_deposited': sum(d.amount for d in deposits.filter(status=DepositStatus.COMPLETED)),
            'pending_deposits': sum(d.amount for d in deposits.filter(status=DepositStatus.PENDING)),
            'failed_deposits': sum(d.amount for d in deposits.filter(status=DepositStatus.FAILED)),
            'current_balance': subscription.account_balance,
            'total_spent': subscription.total_spent,
            'recent_deposits': DepositSerializer(
                deposits[:10],
                many=True
            ).data
        }
        
        return Response(summary)


class SubscriptionFeatureViewSet(viewsets.ModelViewSet):
    serializer_class = SubscriptionFeatureSerializer
    permission_classes = [permissions.IsAuthenticated]

    @staticmethod
    def _is_included_feature(feature):
        return bool(feature and (feature.price_per_day or 0) <= 0)

    def get_queryset(self):
        accessible_subscriptions = SubscriptionViewSet._get_accessible_subscription_queryset(
            self.request,
            allow_staff_access=True,
            admin_staff_only=self.request.method not in permissions.SAFE_METHODS,
        )
        queryset = SubscriptionFeature.objects.filter(subscription__in=accessible_subscriptions)
        business_id = self.request.query_params.get('business')
        if business_id:
            queryset = queryset.filter(subscription__business_id=business_id)
        else:
            first_subscription = accessible_subscriptions.first()
            if first_subscription:
                queryset = queryset.filter(subscription=first_subscription)
        return queryset

    def _resolve_subscription(
        self,
        request,
        allow_staff_access=False,
        admin_staff_only=False,
    ):
        business_id = request.data.get('business') or request.query_params.get('business')
        subscriptions = SubscriptionViewSet._get_accessible_subscription_queryset(
            request,
            allow_staff_access=allow_staff_access,
            admin_staff_only=admin_staff_only,
        )
        if business_id:
            subscriptions = subscriptions.filter(business_id=business_id)
        return subscriptions.first()

    def list(self, request, *args, **kwargs):
        subscription = self._resolve_subscription(request, allow_staff_access=True)
        if subscription:
            # Best effort; don't fail GET due to SQLite write-lock races.
            try:
                subscription.sync_feature_assignments_from_flags()
            except OperationalError as exc:
                logger.warning("Skipping subscription feature sync on list(): %s", exc)
        return super().list(request, *args, **kwargs)

    def create(self, request, *args, **kwargs):
        """Create a new subscription feature"""
        subscription = self._resolve_subscription(
            request,
            allow_staff_access=True,
            admin_staff_only=True,
        )
        if not subscription:
            return Response(
                {'detail': 'No subscription found'},
                status=status.HTTP_404_NOT_FOUND
            )

        serializer = self.get_serializer(
            data=request.data,
            context={'subscription': subscription}
        )
        serializer.is_valid(raise_exception=True)
        feature = serializer.save()

        # Enable the corresponding field on the subscription model
        feature_name = feature.feature.feature
        field_name = f'enable_{feature_name}'
        
        if hasattr(subscription, field_name):
            was_enabled = bool(getattr(subscription, field_name, False))
            setattr(subscription, field_name, True)
            subscription.save(update_fields=[field_name, 'updated_at'])
            if not was_enabled:
                subscription.handle_enabled_feature_side_effects(feature_name)
            print(f"[SUBSCRIPTION_FEATURE] Enabled {field_name} on subscription")
        else:
            print(f"[SUBSCRIPTION_FEATURE] Warning: Field {field_name} not found on Subscription model")

        return Response(
            SubscriptionFeatureSerializer(feature).data,
            status=status.HTTP_201_CREATED
        )

    def destroy(self, request, *args, **kwargs):
        """Delete a subscription feature"""
        try:
            instance = self.get_object()
            if self._is_included_feature(instance.feature):
                return Response(
                    {'detail': 'Included features are always enabled and cannot be disabled.'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Disable the corresponding field on the subscription model
            subscription = instance.subscription
            if subscription.is_free_trial_active():
                return Response(
                    {'detail': TRIAL_FEATURE_LOCK_MESSAGE},
                    status=status.HTTP_400_BAD_REQUEST
                )

            feature_name = instance.feature.feature
            field_name = f'enable_{feature_name}'
            
            if hasattr(subscription, field_name):
                setattr(subscription, field_name, False)
                subscription.save(update_fields=[field_name, 'updated_at'])
                subscription.handle_disabled_feature_side_effects(feature_name)
                print(f"[SUBSCRIPTION_FEATURE] Disabled {field_name} on subscription")
            else:
                print(f"[SUBSCRIPTION_FEATURE] Warning: Field {field_name} not found on Subscription model")
            
            self.perform_destroy(instance)
            return Response(status=status.HTTP_204_NO_CONTENT)
        except Exception as e:
            return Response(
                {'detail': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )

    @action(detail=False, methods=['post'])
    def toggle_feature(self, request):
        """Toggle a feature on/off for the subscription"""
        subscription = self._resolve_subscription(
            request,
            allow_staff_access=True,
            admin_staff_only=True,
        )
        if not subscription:
            return Response(
                {'detail': 'No subscription found'},
                status=status.HTTP_404_NOT_FOUND
            )

        feature_id = request.data.get('feature')
        enabled = SubscriptionViewSet._coerce_bool(request.data.get('enabled'), True)

        if not feature_id:
            return Response(
                {'detail': 'feature ID is required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            feature = FeaturePricing.objects.get(id=feature_id)
        except FeaturePricing.DoesNotExist:
            return Response(
                {'detail': 'Feature not found'},
                status=status.HTTP_404_NOT_FOUND
            )

        if not enabled and self._is_included_feature(feature):
            return Response(
                {'detail': 'Included features are always enabled and cannot be disabled.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        if not enabled and subscription.is_free_trial_active():
            return Response(
                {'detail': TRIAL_FEATURE_LOCK_MESSAGE},
                status=status.HTTP_400_BAD_REQUEST
            )

        if enabled:
            # Create or update subscription feature
            sub_feature, created = SubscriptionFeature.objects.get_or_create(
                subscription=subscription,
                feature=feature,
                defaults={'enabled': True}
            )
            if not created:
                sub_feature.enabled = True
                sub_feature.save()
            field_name = f'enable_{feature.feature}'
            if hasattr(subscription, field_name):
                was_enabled = bool(getattr(subscription, field_name, False))
                setattr(subscription, field_name, True)
                subscription.save(update_fields=[field_name, 'updated_at'])
                if not was_enabled:
                    subscription.handle_enabled_feature_side_effects(feature.feature)
        else:
            # Delete subscription feature
            SubscriptionFeature.objects.filter(
                subscription=subscription,
                feature=feature
            ).delete()
            field_name = f'enable_{feature.feature}'
            if hasattr(subscription, field_name):
                was_enabled = bool(getattr(subscription, field_name, False))
                setattr(subscription, field_name, False)
                subscription.save(update_fields=[field_name, 'updated_at'])
                if was_enabled:
                    subscription.handle_disabled_feature_side_effects(feature.feature)

        # Return updated subscription
        return Response(
            SubscriptionSerializer(subscription).data,
            status=status.HTTP_200_OK
        )


class FeaturePricingViewSet(viewsets.ReadOnlyModelViewSet):
    """
    API endpoint for feature pricing.
    Returns all features for frontend to display and manage.
    """
    queryset = FeaturePricing.objects.all().order_by('feature')
    serializer_class = FeaturePricingSerializer
    permission_classes = [permissions.AllowAny]
    pagination_class = None  # Disable pagination to return all features at once
    filterset_fields = ['is_active']
    search_fields = ['feature', 'description']

    @action(detail=False, methods=['get'])
    def all_features(self, request):
        """Get all feature pricing"""
        features = FeaturePricing.objects.all().order_by('feature')
        serializer = self.get_serializer(features, many=True)
        return Response(serializer.data)
