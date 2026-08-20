from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers

User = get_user_model()

class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = [
            'id', 'email', 'phone', 'first_name', 'last_name', 'is_active',
            'date_joined', 'residence_location',
        ]
        read_only_fields = ['id', 'is_active', 'date_joined']

class RegisterSerializer(serializers.Serializer):
    email = serializers.EmailField(required=False, allow_blank=True)
    phone = serializers.CharField(required=False, allow_blank=True)
    password = serializers.CharField(write_only=True, required=True, style={'input_type': 'password'})
    first_name = serializers.CharField(required=False, allow_blank=True)
    last_name = serializers.CharField(required=False, allow_blank=True)
    residence_location = serializers.CharField(required=False, allow_blank=True, max_length=255)

    def validate(self, attrs):
        print(f"[DEBUG] RegisterSerializer.validate() called with attrs: {attrs}")
        email = attrs.get('email') or None
        phone = attrs.get('phone') or None
        
        print(f"[DEBUG] Email: {email}, Phone: {phone}")
        
        if not email and not phone:
            print("[DEBUG] Neither email nor phone provided")
            raise serializers.ValidationError('Provide either email or phone')

        attrs['residence_location'] = (attrs.get('residence_location') or '').strip()
        
        # Check if email already exists
        if email and User.objects.filter(email=email).exists():
            print(f"[DEBUG] Email {email} already registered")
            raise serializers.ValidationError('Email already registered')
        
        # Check if phone already exists
        if phone and User.objects.filter(phone=phone).exists():
            print(f"[DEBUG] Phone {phone} already registered")
            raise serializers.ValidationError('Phone already registered')
        
        print("[DEBUG] Validation passed")
        return attrs

    def validate_password(self, value: str) -> str:
        print(f"[DEBUG] Validating password: {value[:3]}***")
        try:
            validate_password(value)
            print("[DEBUG] Password validation passed")
        except Exception as e:
            print(f"[DEBUG] Password validation failed: {e}")
            raise
        return value

    def create(self, validated_data):
        print(f"[DEBUG] RegisterSerializer.create() called with validated_data: {validated_data}")
        password = validated_data.pop('password')
        email = validated_data.get('email') or None
        phone = validated_data.get('phone') or None
        first_name = validated_data.get('first_name') or ''
        last_name = validated_data.get('last_name') or ''
        residence_location = validated_data.get('residence_location') or ''
        
        print(f"[DEBUG] Creating user with email={email}, phone={phone}, first_name={first_name}, last_name={last_name}")
        
        user = User.objects.create_user(
            email=email,
            phone=phone,
            password=password,
            first_name=first_name,
            last_name=last_name,
            residence_location=residence_location,
        )
        print(f"[DEBUG] User created successfully: {user.id}")
        return user


class ChangePasswordSerializer(serializers.Serializer):
    current_password = serializers.CharField(write_only=True, required=True, style={'input_type': 'password'})
    new_password = serializers.CharField(write_only=True, required=True, style={'input_type': 'password'})
    confirm_password = serializers.CharField(write_only=True, required=True, style={'input_type': 'password'})

    def validate(self, attrs):
        new_password = attrs.get('new_password')
        confirm_password = attrs.get('confirm_password')

        if new_password != confirm_password:
            raise serializers.ValidationError({'confirm_password': 'Passwords do not match'})

        user = self.context.get('user')
        validate_password(new_password, user=user)
        return attrs
