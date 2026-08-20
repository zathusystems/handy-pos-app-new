import uuid
from django.db import models
from business.models import Business, Branch
from inventory.models import InventoryItem


class Menu(models.Model):
    """Menu model for inventory-backed and prepared menu items."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    business = models.ForeignKey(Business, on_delete=models.CASCADE, related_name='menus')
    branch = models.ForeignKey(Branch, on_delete=models.CASCADE, related_name='menus')
    inventory_item = models.ForeignKey(
        InventoryItem,
        on_delete=models.CASCADE,
        related_name='menu_entries',
        null=True,
        blank=True,
    )
    name = models.CharField(max_length=255, blank=True)
    category = models.CharField(max_length=120, blank=True)
    description = models.TextField(blank=True)
    price = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    image = models.TextField(blank=True, null=True)
    recipe = models.JSONField(default=list, blank=True)
    is_prepared_item = models.BooleanField(default=False)
    is_visible = models.BooleanField(default=True)
    
    # Metadata
    added_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['added_at']
        indexes = [
            models.Index(fields=['business', 'branch']),
            models.Index(fields=['branch', 'inventory_item']),
            models.Index(fields=['branch', 'is_prepared_item']),
        ]

    def __str__(self):
        return f"{self.display_name} - {self.branch.name}"

    @property
    def display_name(self):
        if self.inventory_item_id:
            return self.inventory_item.name
        return self.name or 'Prepared menu item'

    @property
    def display_category(self):
        if self.inventory_item_id:
            return self.inventory_item.category or ''
        return self.category or ''

    @property
    def display_price(self):
        if self.inventory_item_id:
            return self.inventory_item.price or 0
        return self.price or 0

    @property
    def display_image(self):
        if self.inventory_item_id:
            return self.inventory_item.image or ''
        return self.image or ''

    @property
    def display_recipe(self):
        if self.inventory_item_id:
            return self.inventory_item.recipe if isinstance(self.inventory_item.recipe, list) else []
        return self.recipe if isinstance(self.recipe, list) else []


class MenuOptionGroup(models.Model):
    """A selectable group for a menu item, such as size, protein, or sides."""
    GROUP_TYPE_CHOICES = [
        ('option', 'Option'),
        ('side', 'Side'),
        ('addon', 'Add-on'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    menu = models.ForeignKey(Menu, on_delete=models.CASCADE, related_name='option_groups')
    name = models.CharField(max_length=120)
    group_type = models.CharField(max_length=20, choices=GROUP_TYPE_CHOICES, default='option')
    is_required = models.BooleanField(default=False)
    min_select = models.PositiveIntegerField(default=0)
    max_select = models.PositiveIntegerField(default=1)
    sort_order = models.PositiveIntegerField(default=0)
    is_visible = models.BooleanField(default=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['sort_order', 'created_at']
        indexes = [
            models.Index(fields=['menu', 'is_visible']),
            models.Index(fields=['group_type']),
        ]

    def __str__(self):
        return f"{self.menu.display_name} - {self.name}"


class MenuOption(models.Model):
    """A selectable option/side with price and stock-consumption snapshot rules."""
    PRICE_MODE_CHOICES = [
        ('delta', 'Add to base price'),
        ('override', 'Override base price'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    group = models.ForeignKey(MenuOptionGroup, on_delete=models.CASCADE, related_name='options')
    name = models.CharField(max_length=120)
    description = models.CharField(max_length=255, blank=True)
    price_mode = models.CharField(max_length=20, choices=PRICE_MODE_CHOICES, default='delta')
    price_delta = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    price_override = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    recipe = models.JSONField(default=list, blank=True)
    linked_inventory_item = models.ForeignKey(
        InventoryItem,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='menu_options',
        help_text='Optional stock item to consume directly when this option is selected.',
    )
    linked_inventory_quantity = models.DecimalField(max_digits=12, decimal_places=3, default=0)
    is_default = models.BooleanField(default=False)
    is_visible = models.BooleanField(default=True)
    sort_order = models.PositiveIntegerField(default=0)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['sort_order', 'created_at']
        indexes = [
            models.Index(fields=['group', 'is_visible']),
            models.Index(fields=['linked_inventory_item']),
        ]

    def __str__(self):
        return f"{self.group.name} - {self.name}"


class MenuConfig(models.Model):
    """Digital menu configuration for each branch"""
    THEME_CHOICES = [
        ('light', 'Light'),
        ('dark', 'Dark'),
        ('auto', 'Auto (System)'),
    ]

    ITEMS_PER_ROW_CHOICES = [
        ('auto', 'Auto (Responsive)'),
        ('2', '2 Items'),
        ('3', '3 Items'),
        ('4', '4 Items'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    business = models.ForeignKey(Business, on_delete=models.CASCADE, related_name='menu_configs')
    branch = models.OneToOneField(Branch, on_delete=models.CASCADE, related_name='menu_config')
    
    # Branding
    display_name = models.CharField(max_length=255, default='Our Menu')
    description = models.TextField(default='Welcome to our restaurant')
    tagline = models.CharField(max_length=255, default='Fresh & Delicious')
    footer_text = models.CharField(max_length=255, default='Thank you for your visit!')
    
    # Images
    business_logo = models.TextField(blank=True, null=True)  # Base64 encoded
    business_banner = models.TextField(blank=True, null=True)  # Base64 encoded
    
    # Colors
    primary_color = models.CharField(max_length=7, default='#263b57')  # Hex color
    accent_color = models.CharField(max_length=7, default='#236dd5')  # Hex color
    
    # Display Settings
    theme = models.CharField(max_length=10, choices=THEME_CHOICES, default='auto')
    items_per_row = models.CharField(max_length=10, choices=ITEMS_PER_ROW_CHOICES, default='3')
    currency = models.CharField(max_length=10, default='MWK')  # Derived from business settings
    
    # Display Options
    show_prices = models.BooleanField(default=True)
    show_categories = models.BooleanField(default=True)
    show_images = models.BooleanField(default=True)
    show_brand_info = models.BooleanField(default=True)
    show_contact_info = models.BooleanField(default=True)
    
    # Features
    enable_search = models.BooleanField(default=True)
    enable_filters = models.BooleanField(default=True)
    enable_sorting = models.BooleanField(default=True)
    
    # Order Management
    accept_orders = models.BooleanField(default=True)
    
    # Metadata
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']
        indexes = [
            models.Index(fields=['business', 'branch']),
        ]

    def __str__(self):
        return f"Menu Config - {self.branch.name}"
