from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.response import Response
from django.db.models import Sum, Count, Q
from django.utils import timezone
from datetime import timedelta
from .models import Affiliate, BusinessReferral, RecurringCommission, AffiliatePayment, AffiliateSettings, AffiliateStatus
from .serializers import (
    AffiliateSerializer, BusinessReferralSerializer, RecurringCommissionSerializer,
    AffiliatePaymentSerializer, AffiliateSettingsSerializer, AffiliateDashboardSerializer
)

class AffiliateViewSet(viewsets.ModelViewSet):
    serializer_class = AffiliateSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return Affiliate.objects.filter(user=self.request.user)
    
    def get_permissions(self):
        """Override permissions for specific actions"""
        if self.action == 'validate_code':
            return [permissions.AllowAny()]
        return super().get_permissions()

    @action(detail=False, methods=['get', 'post', 'patch'])
    def me(self, request):
        """Get, create, or update current user's affiliate profile"""
        editable_fields = [
            'phone', 'address',
            'residence_region', 'residence_district', 'residence_area',
            'company_name', 'website',
            'bank_account', 'bank_name', 'account_holder', 'swift_code',
        ]
        location_fields = {'residence_region', 'residence_district', 'residence_area'}

        def apply_updates(affiliate_obj: Affiliate):
            for field in editable_fields:
                if field in request.data:
                    setattr(affiliate_obj, field, request.data[field])

            if location_fields.intersection(request.data.keys()):
                region = (affiliate_obj.residence_region or '').strip()
                district = (affiliate_obj.residence_district or '').strip()
                area = (affiliate_obj.residence_area or '').strip()
                if any([region, district, area]) and not all([region, district, area]):
                    return Response(
                        {'detail': 'Region, district, and area are all required together.'},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if region and district and area:
                    affiliate_obj.address = f"{area}, {district}, {region}"

            affiliate_obj.save()
            return None

        try:
            affiliate = Affiliate.objects.get(user=request.user)
            
            if request.method == 'GET':
                serializer = self.get_serializer(affiliate)
                return Response(serializer.data)
            
            elif request.method in ['PATCH', 'POST']:
                print(f"[DEBUG AFFILIATE PATCH] Updating affiliate: {request.user.id}")
                print(f"[DEBUG AFFILIATE PATCH] Request data: {request.data}")

                update_error = apply_updates(affiliate)
                if update_error:
                    return update_error
                print(f"[DEBUG AFFILIATE PATCH] Affiliate updated successfully")
                serializer = self.get_serializer(affiliate)
                return Response(serializer.data, status=status.HTTP_200_OK)
            
        except Affiliate.DoesNotExist:
            if request.method == 'POST':
                affiliate = Affiliate.objects.create(user=request.user)
                update_error = apply_updates(affiliate)
                if update_error:
                    affiliate.delete()
                    return update_error
                serializer = self.get_serializer(affiliate)
                return Response(serializer.data, status=status.HTTP_201_CREATED)
            return Response({'detail': 'Affiliate profile not found'}, status=status.HTTP_404_NOT_FOUND)

    @action(
        detail=False,
        methods=['post'],
        url_path='upload-profile-picture',
        url_name='upload-profile-picture',
        parser_classes=[MultiPartParser, FormParser],
    )
    def upload_profile_picture(self, request):
        """Upload profile picture for current affiliate profile."""
        try:
            affiliate = Affiliate.objects.get(user=request.user)
        except Affiliate.DoesNotExist:
            return Response({'detail': 'Affiliate profile not found'}, status=status.HTTP_404_NOT_FOUND)

        uploaded_file = request.FILES.get('file')
        if not uploaded_file:
            return Response({'detail': 'No file provided'}, status=status.HTTP_400_BAD_REQUEST)

        content_type = (getattr(uploaded_file, 'content_type', '') or '').lower()
        if content_type and not content_type.startswith('image/'):
            return Response({'detail': 'Only image uploads are allowed'}, status=status.HTTP_400_BAD_REQUEST)

        if affiliate.profile_picture:
            affiliate.profile_picture.delete(save=False)

        affiliate.profile_picture = uploaded_file
        affiliate.save()

        serializer = self.get_serializer(affiliate)
        return Response({'profile_picture': serializer.data.get('profile_picture')}, status=status.HTTP_200_OK)

    @action(detail=False, methods=['get'])
    def dashboard(self, request):
        """Get affiliate dashboard stats"""
        try:
            affiliate = Affiliate.objects.get(user=request.user)
            
            # Calculate stats
            total_commissions = affiliate.recurring_commissions.aggregate(Sum('amount'))['amount__sum'] or 0
            total_paid = affiliate.payments.filter(status='completed').aggregate(Sum('amount'))['amount__sum'] or 0
            pending_commissions = affiliate.recurring_commissions.filter(status='pending').aggregate(Sum('amount'))['amount__sum'] or 0
            available_for_payout = affiliate.total_commissions - affiliate.total_paid
            
            # Active referral rate
            active_referrals = affiliate.business_referrals.filter(status='active').count()
            active_referral_rate = (active_referrals / affiliate.total_referred_businesses * 100) if affiliate.total_referred_businesses > 0 else 0
            
            # Recent data
            recent_referrals = affiliate.business_referrals.all()[:5]
            recent_commissions = affiliate.recurring_commissions.all()[:5]
            
            data = {
                'total_referred_businesses': affiliate.total_referred_businesses,
                'total_active_referrals': affiliate.total_active_referrals,
                'total_commissions': total_commissions,
                'total_paid': total_paid,
                'pending_commissions': pending_commissions,
                'available_for_payout': available_for_payout,
                'active_referral_rate': active_referral_rate,
                'recent_referrals': recent_referrals,
                'recent_commissions': recent_commissions,
            }
            
            serializer = AffiliateDashboardSerializer(data)
            return Response(serializer.data)
        except Affiliate.DoesNotExist:
            return Response({'detail': 'Affiliate profile not found'}, status=status.HTTP_404_NOT_FOUND)

    @action(detail=False, methods=['get'], url_path='validate-code', url_name='validate-code')
    def validate_code(self, request):
        """Validate referral code and return affiliate name - public endpoint"""
        code = request.query_params.get('code', '').strip()
        
        if not code:
            return Response(
                {'valid': False, 'message': 'Referral code is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        try:
            # Accept both active and pending affiliates
            affiliate = Affiliate.objects.get(
                affiliate_code=code,
                status__in=['active', 'pending']
            )
            # Get user's full name or email
            full_name = f"{affiliate.user.first_name} {affiliate.user.last_name}".strip()
            name = full_name or affiliate.user.email
            
            return Response({
                'valid': True,
                'name': name,
                'affiliate_id': affiliate.id,
                'company_name': affiliate.company_name,
            })
        except Affiliate.DoesNotExist:
            return Response({
                'valid': False,
                'message': 'Invalid or inactive referral code'
            })
        except Exception as e:
            return Response({
                'valid': False,
                'message': f'Error validating code: {str(e)}'
            }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @action(detail=False, methods=['post'])
    def associate_business(self, request):
        """Associate a business with an affiliate using referral code"""
        referral_code = request.data.get('referral_code', '').strip()
        business_id = request.data.get('business_id')
        
        if not referral_code or not business_id:
            return Response(
                {'detail': 'Referral code and business ID are required'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        try:
            # Find the affiliate by referral code
            affiliate = Affiliate.objects.get(affiliate_code=referral_code, status=AffiliateStatus.ACTIVE)
        except Affiliate.DoesNotExist:
            return Response(
                {'detail': 'Invalid or inactive referral code'},
                status=status.HTTP_404_NOT_FOUND
            )
        
        try:
            from business.models import Business
            business = Business.objects.get(id=business_id)
        except Business.DoesNotExist:
            return Response(
                {'detail': 'Business not found'},
                status=status.HTTP_404_NOT_FOUND
            )
        
        # Check if business is already associated with an affiliate
        if hasattr(business, 'referral') and business.referral:
            return Response(
                {'detail': 'Business is already associated with an affiliate'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        try:
            # Create the business referral
            business_referral = BusinessReferral.objects.create(
                affiliate=affiliate,
                business=business,
                referral_code=referral_code,
                status='active',
                activated_at=timezone.now()
            )
            
            # Update affiliate stats
            affiliate.total_referred_businesses += 1
            affiliate.total_active_referrals += 1
            affiliate.save()
            
            serializer = BusinessReferralSerializer(business_referral)
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        except Exception as e:
            return Response(
                {'detail': f'Failed to associate business: {str(e)}'},
                status=status.HTTP_400_BAD_REQUEST
            )

    @action(detail=False, methods=['post'])
    def request_payout(self, request):
        """Request payout for available commissions"""
        try:
            affiliate = Affiliate.objects.get(user=request.user)
            payment_method = (request.data.get('payment_method') or 'bank_transfer').strip().lower()

            if affiliate.status != AffiliateStatus.ACTIVE:
                return Response(
                    {'detail': f'Payout requests are only allowed for active partner accounts. Current status: {affiliate.status}.'},
                    status=status.HTTP_403_FORBIDDEN
                )
            
            # Check if there are available commissions
            available = affiliate.total_commissions - affiliate.total_paid
            settings = AffiliateSettings.get_current()

            # Prevent duplicate payout requests while one is still being handled.
            has_open_request = affiliate.payments.filter(status__in=['pending', 'processing']).exists()
            if has_open_request:
                return Response(
                    {'detail': 'You already have a payout request in progress.'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            if available <= 0:
                return Response(
                    {'detail': 'No commissions available for payout.'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            if available < (settings.min_commission_for_payout if settings else 50):
                return Response(
                    {'detail': f'Minimum commission for payout is ${settings.min_commission_for_payout if settings else 50}'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            if payment_method == 'bank_transfer':
                missing_fields = []
                if not (affiliate.bank_name or '').strip():
                    missing_fields.append('bank name')
                if not (affiliate.account_holder or '').strip():
                    missing_fields.append('account holder')
                if not (affiliate.bank_account or '').strip():
                    missing_fields.append('bank account')

                if missing_fields:
                    return Response(
                        {
                            'detail': (
                                'Payout account is incomplete. '
                                f"Please add {', '.join(missing_fields)} in your profile."
                            )
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
            
            # Create payment request
            payment = AffiliatePayment.objects.create(
                affiliate=affiliate,
                amount=available,
                payment_method=payment_method,
                notes=request.data.get('notes', '')
            )
            
            serializer = AffiliatePaymentSerializer(payment)
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        except Affiliate.DoesNotExist:
            return Response({'detail': 'Affiliate profile not found'}, status=status.HTTP_404_NOT_FOUND)


class BusinessReferralViewSet(viewsets.ModelViewSet):
    serializer_class = BusinessReferralSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return BusinessReferral.objects.filter(affiliate__user=self.request.user)


class RecurringCommissionViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = RecurringCommissionSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return RecurringCommission.objects.filter(affiliate__user=self.request.user)

    @action(detail=False, methods=['get'])
    def summary(self, request):
        """Get commission summary"""
        queryset = self.get_queryset()
        
        summary = {
            'total': queryset.aggregate(Sum('amount'))['amount__sum'] or 0,
            'pending': queryset.filter(status='pending').aggregate(Sum('amount'))['amount__sum'] or 0,
            'approved': queryset.filter(status='approved').aggregate(Sum('amount'))['amount__sum'] or 0,
            'paid': queryset.filter(status='paid').aggregate(Sum('amount'))['amount__sum'] or 0,
            'rejected': queryset.filter(status='rejected').aggregate(Sum('amount'))['amount__sum'] or 0,
        }
        
        return Response(summary)


class AffiliatePaymentViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = AffiliatePaymentSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return AffiliatePayment.objects.filter(affiliate__user=self.request.user)


class AffiliateSettingsViewSet(viewsets.ViewSet):
    permission_classes = [permissions.IsAuthenticated]

    def _program_settings_response(self):
        settings = AffiliateSettings.get_current()
        serializer = AffiliateSettingsSerializer(settings)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def program_settings(self, request):
        """Get affiliate program settings"""
        return self._program_settings_response()

    @action(detail=False, methods=['get'], url_path='program-settings', url_name='program-settings')
    def program_settings_hyphen(self, request):
        """Get affiliate program settings (hyphenated alias)."""
        return self._program_settings_response()
