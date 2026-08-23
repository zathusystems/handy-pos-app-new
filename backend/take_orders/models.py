import uuid
from django.db import models
from django.contrib.auth import get_user_model
from business.models import Business, Branch, Customer

User = get_user_model()


class TakeOrder(models.Model):
    """Take Order model - separate from POS sales for kitchen preparation"""
    STATUS_CHOICES = [
        ('Pending', 'Pending'),
        ('Confirmed', 'Confirmed'),
        ('Sent to Kitchen', 'Sent to Kitchen'),
        ('Preparing', 'Preparing'),
        ('Ready', 'Ready'),
        ('Completed', 'Completed'),
        ('Cancelled', 'Cancelled'),
    ]
    
    ORDER_TYPE_CHOICES = [
        ('staff', 'Staff Created'),
        ('self_service', 'Self-Service'),
    ]

    # UUID field for frontend-backend sync
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    
    # Relations
    business = models.ForeignKey(Business, on_delete=models.CASCADE, related_name='take_orders')
    branch = models.ForeignKey(Branch, on_delete=models.CASCADE, related_name='take_orders')
    created_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='take_orders_created')
    completed_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='take_orders_completed')
    customer = models.ForeignKey(Customer, on_delete=models.SET_NULL, null=True, blank=True, related_name='take_orders')
    
    # Order info
    order_number = models.IntegerField()  # Sequential number per branch
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='Pending')
    order_type = models.CharField(max_length=20, choices=ORDER_TYPE_CHOICES, default='staff')
    
    # Customer info (optional)
    customer_name = models.CharField(max_length=255, blank=True, null=True)
    customer_phone = models.CharField(max_length=20, blank=True, null=True)
    customer_notes = models.TextField(blank=True, null=True)
    table_number = models.CharField(max_length=50, blank=True, null=True)
    
    # Order details
    special_instructions = models.TextField(blank=True, null=True)
    cancellation_reason = models.TextField(blank=True, null=True)
    
    # Timestamps
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['branch', 'status']),
            models.Index(fields=['branch', 'created_at']),
            models.Index(fields=['branch', 'order_type']),
            models.Index(fields=['created_by']),
            models.Index(fields=['completed_by']),
            models.Index(fields=['status']),
            models.Index(fields=['order_type']),
        ]
        unique_together = ('branch', 'order_number')

    def __str__(self):
        return f"Take Order #{self.order_number} - {self.status} ({self.get_order_type_display()})"

    @classmethod
    def next_order_number_for_branch(cls, branch):
        last_order = cls.objects.filter(branch=branch).order_by('-order_number').first()
        return (last_order.order_number + 1) if last_order else 1


class TakeOrderItem(models.Model):
    """Individual items in a take order"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    take_order = models.ForeignKey(TakeOrder, on_delete=models.CASCADE, related_name='items')
    
    # Item info (stored as denormalized data for flexibility)
    inventory_item_id = models.CharField(max_length=255, blank=True)  # Reference to inventory item UUID
    menu_item_id = models.CharField(max_length=255, blank=True)
    name = models.CharField(max_length=255)
    quantity = models.DecimalField(max_digits=12, decimal_places=3)
    price = models.DecimalField(max_digits=12, decimal_places=2, default=0)  # Price per unit at time of order
    notes = models.TextField(blank=True, null=True)
    recipe = models.JSONField(
        default=list,
        blank=True,
        help_text='Snapshot of menu item recipe for prepared menu-only items.',
    )
    is_prepared_menu_item = models.BooleanField(default=False)
    selected_options = models.JSONField(
        default=list,
        blank=True,
        help_text='Snapshot of selected meal options/sides, including names, prices, and stock recipes.',
    )
    
    # Timestamps
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['take_order']),
            models.Index(fields=['inventory_item_id']),
        ]

    def __str__(self):
        return f"{self.name} x {self.quantity} @ {self.price}"
