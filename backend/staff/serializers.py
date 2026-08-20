from rest_framework import serializers
from django.contrib.auth import get_user_model
from django.db import transaction
from .models import Staff, StaffRole

User = get_user_model()

class StaffSerializer(serializers.ModelSerializer):
    class Meta:
        model = Staff
        fields = [
            'id', 'business', 'branch', 'name', 'email', 'phone', 'role',
            'assigned_product_type', 'is_fuel_attendant',
            'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']

class StaffCreateSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, required=True, min_length=6)

    class Meta:
        model = Staff
        fields = ['name', 'email', 'phone', 'password', 'role', 'branch', 'assigned_product_type', 'is_fuel_attendant']

    def validate(self, attrs):
        return attrs

    def create(self, validated_data):
        password = validated_data.pop('password')
        branch = validated_data.get('branch')
        business = getattr(branch, 'business', None)

        if not business:
            raise serializers.ValidationError('Branch is required to assign staff to a business')

        # Enforce that requester belongs to the same business (owner or admin staff)
        request_user = self.context['request'].user
        if business.owner != request_user:
            try:
                requester_staff = Staff.objects.get(user=request_user)
                if requester_staff.business_id != business.id or requester_staff.role != StaffRole.ADMIN:
                    raise serializers.ValidationError('You do not have permission to add staff to this business')
            except Staff.DoesNotExist:
                raise serializers.ValidationError('You do not have permission to add staff to this business')

        # Create user account
        user = User.objects.create_user(
            email=validated_data['email'],
            password=password,
            first_name=validated_data['name'].split()[0] if validated_data['name'] else '',
        )

        # Create staff record
        staff = Staff.objects.create(
            business=business,
            user=user,
            **validated_data
        )
        return staff

class StaffUpdateSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, required=False, allow_blank=True, min_length=6)

    class Meta:
        model = Staff
        fields = [
            'name',
            'email',
            'phone',
            'role',
            'branch',
            'is_active',
            'assigned_product_type',
            'is_fuel_attendant',
            'password',
        ]

    def validate(self, attrs):
        branch = attrs.get('branch')
        instance = getattr(self, 'instance', None)

        if branch and instance and branch.business_id != instance.business_id:
            raise serializers.ValidationError({
                'branch': 'Selected branch must belong to the same business as this staff member.'
            })

        email = attrs.get('email')
        linked_user = getattr(instance, 'user', None)
        if email and linked_user:
            existing_user = User.objects.exclude(pk=linked_user.pk).filter(email=email).exists()
            if existing_user:
                raise serializers.ValidationError({
                    'email': 'A user with this email already exists.'
                })

        return attrs

    def update(self, instance, validated_data):
        password = validated_data.pop('password', '').strip()
        linked_user = instance.user

        with transaction.atomic():
            for attr, value in validated_data.items():
                setattr(instance, attr, value)
            instance.save()

            if linked_user:
                user_fields = []
                if 'name' in validated_data:
                    full_name = (validated_data.get('name') or '').strip()
                    name_parts = full_name.split(maxsplit=1)
                    linked_user.first_name = name_parts[0] if name_parts else ''
                    linked_user.last_name = name_parts[1] if len(name_parts) > 1 else ''
                    user_fields.extend(['first_name', 'last_name'])

                if 'email' in validated_data:
                    linked_user.email = validated_data['email']
                    user_fields.append('email')

                if 'is_active' in validated_data:
                    linked_user.is_active = validated_data['is_active']
                    user_fields.append('is_active')

                if password:
                    linked_user.set_password(password)
                    user_fields.append('password')

                if user_fields:
                    linked_user.save(update_fields=list(dict.fromkeys(user_fields)))

        return instance
