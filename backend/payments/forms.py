from django import forms
from django.conf import settings
from django.urls import reverse
from urllib.parse import urljoin

from .models import PaymentGatewayConfiguration
from .validators import validate_redirect_url


class PaymentGatewayConfigurationAdminForm(forms.ModelForm):
    public_key = forms.CharField(
        required=False,
        help_text='Public key from the payment gateway dashboard. Leave blank if your provider does not require it.',
    )
    callback_url = forms.CharField(
        required=False,
        help_text=(
            'App success destination. For the Tauri and Android app, use '
            'handypos://subscription-payment/{deposit_id}. The backend will convert it into a '
            'public HTTPS bridge URL for PayChangu when PAYMENT_PUBLIC_BASE_URL is set.'
        ),
    )
    return_url = forms.CharField(
        required=False,
        help_text=(
            'App cancel or failure destination. For the Tauri and Android app, use '
            'handypos://subscription-payment/{deposit_id}. The backend will convert it into a '
            'public HTTPS bridge URL for PayChangu when PAYMENT_PUBLIC_BASE_URL is set.'
        ),
    )
    secret_key = forms.CharField(
        required=False,
        widget=forms.PasswordInput(render_value=False),
        help_text='Leave blank to keep the current PayChangu secret key.',
    )
    webhook_secret = forms.CharField(
        required=False,
        widget=forms.PasswordInput(render_value=False),
        help_text='Leave blank to keep the current webhook signing secret.',
    )

    class Meta:
        model = PaymentGatewayConfiguration
        fields = '__all__'

    def clean_callback_url(self):
        return validate_redirect_url(
            self.cleaned_data.get('callback_url'),
            field_name='callback_url',
        )

    def clean_return_url(self):
        return validate_redirect_url(
            self.cleaned_data.get('return_url'),
            field_name='return_url',
        )

    def clean_default_currency(self):
        return str(self.cleaned_data.get('default_currency') or '').upper()

    def clean_secret_key(self):
        secret_key = str(self.cleaned_data.get('secret_key') or '').strip()
        if secret_key:
            return secret_key
        if self.instance and self.instance.pk:
            return self.instance.secret_key
        return ''

    def clean_webhook_secret(self):
        webhook_secret = str(self.cleaned_data.get('webhook_secret') or '').strip()
        if webhook_secret:
            return webhook_secret
        if self.instance and self.instance.pk:
            return self.instance.webhook_secret
        return ''


def build_payment_webhook_url():
    base_url = str(getattr(settings, 'PAYMENT_PUBLIC_BASE_URL', '') or '').strip()
    webhook_path = reverse('paychangu-webhook')
    if base_url:
        return urljoin(f'{base_url.rstrip("/")}/', webhook_path.lstrip('/'))
    return webhook_path
