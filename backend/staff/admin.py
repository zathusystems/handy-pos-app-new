from django.contrib import admin
from .models import Staff

@admin.register(Staff)
class StaffAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'email', 'role', 'business', 'branch', 'is_active', 'created_at')
    search_fields = ('name', 'email', 'business__name')
    list_filter = ('role', 'is_active', 'business', 'created_at')
    ordering = ('-created_at',)
