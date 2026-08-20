from django.db import models
from django.contrib.auth import get_user_model
from business.models import Business, Branch

User = get_user_model()

class StaffRole(models.TextChoices):
    ADMIN = 'Admin', 'Administrator'
    MANAGER = 'Manager', 'Manager'
    CASHIER = 'Cashier', 'Cashier'
    WAITER = 'Waiter', 'Waiter'
    KITCHEN_STAFF = 'Kitchen Staff', 'Kitchen Staff'

class Staff(models.Model):
    business = models.ForeignKey(Business, on_delete=models.CASCADE, related_name='staff_members')
    branch = models.ForeignKey(Branch, on_delete=models.SET_NULL, null=True, blank=True, related_name='staff')
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='staff_profile', null=True, blank=True)
    name = models.CharField(max_length=255)
    email = models.EmailField(unique=True)
    phone = models.CharField(max_length=32, blank=True)
    role = models.CharField(max_length=20, choices=StaffRole.choices, default=StaffRole.CASHIER)
    assigned_product_type = models.CharField(max_length=100, blank=True, null=True)
    is_fuel_attendant = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    disabled_by_feature = models.CharField(
        max_length=50,
        blank=True,
        default='',
        help_text='Subscription feature that auto-disabled this staff account, if any.',
    )
    disabled_by_feature_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text='When this staff account was auto-disabled by a subscription feature.',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    # Sync tracking
    is_dirty = models.BooleanField(
        default=True,
        help_text="Marks record as dirty (needs syncing). Set to False after successful sync."
    )

    class Meta:
        ordering = ['-created_at']
        unique_together = ('business', 'email')
        indexes = [
            models.Index(fields=['business', 'is_active']),
            models.Index(fields=['is_dirty']),
        ]

    def __str__(self):
        return f"{self.name} ({self.role}) - {self.business.name}"

    def mark_dirty(self):
        """Mark this record as dirty (needs syncing)"""
        self.is_dirty = True
        self.save(update_fields=['is_dirty'])

    def mark_synced(self):
        """Mark this record as synced"""
        self.is_dirty = False
        self.save(update_fields=['is_dirty'])
