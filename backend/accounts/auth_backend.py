from django.contrib.auth.backends import ModelBackend
from django.contrib.auth import get_user_model

User = get_user_model()

class EmailOrPhoneBackend(ModelBackend):
    def authenticate(self, request, username=None, password=None, **kwargs):
        identifier = kwargs.get('email') or kwargs.get('phone') or username
        if not identifier or not password:
            return None
        user = None
        # try email
        try:
            user = User.objects.get(email__iexact=identifier)
        except User.DoesNotExist:
            # try phone
            try:
                user = User.objects.get(phone=identifier)
            except User.DoesNotExist:
                return None
        if user and user.check_password(password) and self.user_can_authenticate(user):
            return user
        return None
