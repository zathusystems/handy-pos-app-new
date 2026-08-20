"""
Affiliate Commission Service
Handles commission calculation and creation for successful subscription payments
"""
from decimal import Decimal
from django.utils import timezone
from django.db import transaction, models
from subscription.models import Subscription, Deposit, DepositStatus
from affiliate.models import (
    BusinessReferral, RecurringCommission, Affiliate, AffiliateSettings,
    CommissionStatus
)
import logging

logger = logging.getLogger(__name__)


class AffiliateCommissionService:
    """Service to manage affiliate commissions"""

    @staticmethod
    def get_affiliate_settings():
        """Get or create affiliate settings"""
        return AffiliateSettings.get_current()

    @staticmethod
    def get_business_referral(business_id):
        """Get business referral if exists"""
        try:
            return BusinessReferral.objects.select_related('affiliate').get(
                business_id=business_id,
                status='active'
            )
        except BusinessReferral.DoesNotExist:
            return None

    @staticmethod
    def calculate_commission(amount, settings):
        """Calculate commission based on global affiliate settings"""
        if settings.default_commission_type == 'percentage':
            commission = amount * (settings.default_commission_rate / Decimal('100'))
        else:  # fixed
            commission = settings.default_commission_rate
        
        return commission

    @classmethod
    def process_deposit_commission(cls, deposit):
        """
        Process affiliate commission when deposit is completed
        Called when a subscription deposit is completed
        
        Args:
            deposit: Deposit instance
        
        Returns:
            tuple: (success, message, commission_amount)
        """
        try:
            # Check if deposit is completed
            if deposit.status != DepositStatus.COMPLETED:
                return False, "Deposit is not completed", Decimal('0')
            
            # Get subscription
            subscription = deposit.subscription
            
            # Check if business has affiliate connection
            referral = cls.get_business_referral(subscription.business_id)
            if not referral:
                return False, "No active affiliate referral found", Decimal('0')
            
            # Get affiliate
            affiliate = referral.affiliate
            
            # Check if affiliate is active
            if affiliate.status != 'active':
                return False, f"Affiliate is not active: {affiliate.status}", Decimal('0')
            
            # Get affiliate settings
            settings = cls.get_affiliate_settings()
            
            # Check if commission on subscription is enabled
            if not settings.commission_on_subscription:
                return False, "Commission on subscription is disabled", Decimal('0')
            
            # Calculate commission using global settings
            commission_amount = cls.calculate_commission(deposit.amount, settings)
            
            # Validate commission amount is positive
            if commission_amount <= 0:
                return False, "Commission amount must be positive", Decimal('0')
            
            # Create recurring commission record
            with transaction.atomic():
                # Get current billing month (first day of current month)
                today = timezone.now().date()
                billing_month = today.replace(day=1)
                
                # Use atomic get_or_create to prevent race conditions
                commission, created = RecurringCommission.objects.get_or_create(
                    business_referral=referral,
                    billing_month=billing_month,
                    commission_type='monthly_recurring',
                    defaults={
                        'affiliate': affiliate,
                        'subscription': subscription,
                        'amount': commission_amount,
                        'status': CommissionStatus.PENDING,
                        'commission_rate': settings.default_commission_rate,
                        'commission_rate_type': settings.default_commission_type,
                    }
                )
                
                if not created:
                    # Update existing commission (add to amount)
                    commission.amount += commission_amount
                    commission.save()
                    logger.info(
                        f"Updated commission for {affiliate.user.email}: "
                        f"+{commission_amount} (Total: {commission.amount})"
                    )
                else:
                    logger.info(
                        f"Created commission for {affiliate.user.email}: "
                        f"{commission_amount} ({settings.default_commission_rate}% {settings.default_commission_type}) "
                        f"(Deposit: {deposit.deposit_id})"
                    )
                
                # Update affiliate stats
                affiliate.total_commissions += commission_amount
                affiliate.save()
                
                return True, f"Commission created: {commission_amount}", commission_amount
        
        except Exception as e:
            logger.error(f"Error processing deposit commission: {str(e)}")
            return False, f"Error: {str(e)}", Decimal('0')

    @classmethod
    def process_subscription_payment_commission(cls, subscription, amount, payment_type='monthly_recurring'):
        """
        Process affiliate commission for subscription payment
        Can be called for signup bonus, first month, or monthly recurring
        
        Args:
            subscription: Subscription instance
            amount: Payment amount
            payment_type: 'signup_bonus', 'first_month', or 'monthly_recurring'
        
        Returns:
            tuple: (success, message, commission_amount)
        """
        try:
            # Check if business has affiliate connection
            referral = cls.get_business_referral(subscription.business_id)
            if not referral:
                return False, "No active affiliate referral found", Decimal('0')
            
            # Get affiliate
            affiliate = referral.affiliate
            
            # Check if affiliate is active
            if affiliate.status != 'active':
                return False, f"Affiliate is not active: {affiliate.status}", Decimal('0')
            
            # Get affiliate settings
            settings = cls.get_affiliate_settings()
            
            # Check if commission type is enabled
            if payment_type == 'signup_bonus' and not settings.commission_on_signup:
                return False, "Commission on signup is disabled", Decimal('0')
            elif payment_type == 'first_month' and not settings.commission_on_first_purchase:
                return False, "Commission on first purchase is disabled", Decimal('0')
            elif payment_type == 'monthly_recurring' and not settings.commission_on_monthly_recurring:
                return False, "Commission on monthly recurring is disabled", Decimal('0')
            
            # Calculate commission using global settings
            commission_amount = cls.calculate_commission(amount, settings)
            
            # Validate commission amount is positive
            if commission_amount <= 0:
                return False, "Commission amount must be positive", Decimal('0')
            
            # Create commission record
            with transaction.atomic():
                # Get current billing month
                today = timezone.now().date()
                billing_month = today.replace(day=1)
                
                # Create commission record
                commission = RecurringCommission.objects.create(
                    affiliate=affiliate,
                    business_referral=referral,
                    subscription=subscription,
                    amount=commission_amount,
                    status=CommissionStatus.PENDING,
                    commission_type=payment_type,
                    commission_rate=settings.default_commission_rate,
                    commission_rate_type=settings.default_commission_type,
                    billing_month=billing_month
                )
                
                logger.info(
                    f"Created {payment_type} commission for {affiliate.user.email}: "
                    f"{commission_amount} ({settings.default_commission_rate}% {settings.default_commission_type}) "
                    f"(Subscription: {subscription.id})"
                )
                
                # Update affiliate stats
                affiliate.total_commissions += commission_amount
                affiliate.save()
                
                return True, f"Commission created: {commission_amount}", commission_amount
        
        except Exception as e:
            logger.error(f"Error processing subscription payment commission: {str(e)}")
            return False, f"Error: {str(e)}", Decimal('0')

    @classmethod
    def approve_commission(cls, commission_id, approved_by):
        """Approve a pending commission"""
        try:
            commission = RecurringCommission.objects.get(id=commission_id)
            
            if commission.status != CommissionStatus.PENDING:
                return False, f"Commission is already {commission.status}"
            
            commission.status = CommissionStatus.APPROVED
            commission.approved_date = timezone.now()
            commission.save()
            
            logger.info(f"Approved commission {commission_id} by {approved_by}")
            return True, "Commission approved"
        
        except RecurringCommission.DoesNotExist:
            return False, "Commission not found"
        except Exception as e:
            logger.error(f"Error approving commission: {str(e)}")
            return False, f"Error: {str(e)}"

    @classmethod
    def reject_commission(cls, commission_id, rejected_by):
        """Reject a pending commission"""
        try:
            commission = RecurringCommission.objects.get(id=commission_id)
            
            if commission.status != CommissionStatus.PENDING:
                return False, f"Commission is already {commission.status}"
            
            # Deduct from affiliate total
            affiliate = commission.affiliate
            affiliate.total_commissions -= commission.amount
            affiliate.save()
            
            commission.status = CommissionStatus.REJECTED
            commission.save()
            
            logger.info(f"Rejected commission {commission_id} by {rejected_by}")
            return True, "Commission rejected"
        
        except RecurringCommission.DoesNotExist:
            return False, "Commission not found"
        except Exception as e:
            logger.error(f"Error rejecting commission: {str(e)}")
            return False, f"Error: {str(e)}"

    @classmethod
    def mark_commission_paid(cls, commission_id, transaction_id=None):
        """Mark commission as paid"""
        try:
            commission = RecurringCommission.objects.get(id=commission_id)
            
            if commission.status != CommissionStatus.APPROVED:
                return False, f"Commission must be approved before marking as paid"
            
            commission.status = CommissionStatus.PAID
            commission.paid_date = timezone.now()
            if transaction_id:
                commission.transaction_id = transaction_id
            commission.save()
            
            # Update affiliate stats
            affiliate = commission.affiliate
            affiliate.total_paid += commission.amount
            affiliate.save()
            
            logger.info(f"Marked commission {commission_id} as paid")
            return True, "Commission marked as paid"
        
        except RecurringCommission.DoesNotExist:
            return False, "Commission not found"
        except Exception as e:
            logger.error(f"Error marking commission as paid: {str(e)}")
            return False, f"Error: {str(e)}"

    @classmethod
    def get_affiliate_pending_commissions(cls, affiliate_id):
        """Get all pending commissions for an affiliate"""
        try:
            commissions = RecurringCommission.objects.filter(
                affiliate_id=affiliate_id,
                status=CommissionStatus.PENDING
            ).select_related('business_referral', 'subscription')
            
            total_pending = sum(c.amount for c in commissions)
            
            return {
                'commissions': commissions,
                'total_pending': total_pending,
                'count': commissions.count()
            }
        except Exception as e:
            logger.error(f"Error getting pending commissions: {str(e)}")
            return {
                'commissions': [],
                'total_pending': Decimal('0'),
                'count': 0
            }

    @classmethod
    def get_affiliate_approved_commissions(cls, affiliate_id):
        """Get all approved but unpaid commissions for an affiliate"""
        try:
            commissions = RecurringCommission.objects.filter(
                affiliate_id=affiliate_id,
                status=CommissionStatus.APPROVED
            ).select_related('business_referral', 'subscription')
            
            total_approved = sum(c.amount for c in commissions)
            
            return {
                'commissions': commissions,
                'total_approved': total_approved,
                'count': commissions.count()
            }
        except Exception as e:
            logger.error(f"Error getting approved commissions: {str(e)}")
            return {
                'commissions': [],
                'total_approved': Decimal('0'),
                'count': 0
            }

    @classmethod
    def get_affiliate_stats(cls, affiliate_id):
        """Get comprehensive affiliate statistics"""
        try:
            affiliate = Affiliate.objects.get(id=affiliate_id)
            
            pending = RecurringCommission.objects.filter(
                affiliate_id=affiliate_id,
                status=CommissionStatus.PENDING
            ).aggregate(total=models.Sum('amount'))['total'] or Decimal('0')
            
            approved = RecurringCommission.objects.filter(
                affiliate_id=affiliate_id,
                status=CommissionStatus.APPROVED
            ).aggregate(total=models.Sum('amount'))['total'] or Decimal('0')
            
            paid = RecurringCommission.objects.filter(
                affiliate_id=affiliate_id,
                status=CommissionStatus.PAID
            ).aggregate(total=models.Sum('amount'))['total'] or Decimal('0')
            
            return {
                'affiliate_id': affiliate_id,
                'affiliate_name': affiliate.user.email,
                'commission_rate': affiliate.commission_rate,
                'commission_type': affiliate.commission_type,
                'total_commissions': affiliate.total_commissions,
                'total_paid': affiliate.total_paid,
                'pending_commissions': pending,
                'approved_commissions': approved,
                'paid_commissions': paid,
                'total_referred_businesses': affiliate.total_referred_businesses,
                'total_active_referrals': affiliate.total_active_referrals,
            }
        except Affiliate.DoesNotExist:
            return None
        except Exception as e:
            logger.error(f"Error getting affiliate stats: {str(e)}")
            return None


# Export service instance
affiliate_commission_service = AffiliateCommissionService()
