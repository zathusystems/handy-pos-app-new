from decimal import Decimal

from django.conf import settings
from django.db import migrations, models
import django.core.validators


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('subscription', '0015_alter_featurepricing_feature'),
    ]

    operations = [
        migrations.CreateModel(
            name='PaymentGatewayConfiguration',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('provider', models.CharField(choices=[('paychangu', 'PayChangu')], default='paychangu', max_length=50)),
                ('display_name', models.CharField(default='PayChangu', max_length=255)),
                ('is_active', models.BooleanField(default=False, help_text='Enable this gateway for subscription credit payments.')),
                ('environment', models.CharField(choices=[('sandbox', 'Sandbox'), ('live', 'Live')], default='sandbox', max_length=20)),
                ('checkout_flow', models.CharField(choices=[('hosted_checkout', 'Hosted Checkout')], default='hosted_checkout', max_length=50)),
                ('public_key', models.CharField(blank=True, max_length=255)),
                ('secret_key', models.CharField(blank=True, max_length=255)),
                ('webhook_secret', models.CharField(blank=True, max_length=255)),
                ('checkout_init_url', models.URLField(default='https://api.paychangu.com/payment')),
                ('verify_url_template', models.URLField(default='https://api.paychangu.com/verify-payment/{tx_ref}')),
                ('callback_url', models.URLField(blank=True, help_text='Success callback URL sent to PayChangu when generating hosted checkout.')),
                ('return_url', models.URLField(blank=True, help_text='Return URL used when the customer cancels or payment ultimately fails.')),
                ('default_currency', models.CharField(default='MWK', max_length=3)),
                ('payment_title', models.CharField(default='HandyPOS Subscription Top-up', max_length=255)),
                ('payment_description', models.CharField(default='Add credits to your HandyPOS subscription', max_length=255)),
                ('metadata', models.JSONField(blank=True, default=dict)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'verbose_name': 'Payment Gateway Configuration',
                'verbose_name_plural': 'Payment Gateway Configuration',
            },
        ),
        migrations.CreateModel(
            name='SubscriptionPaymentAttempt',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('provider', models.CharField(choices=[('paychangu', 'PayChangu')], default='paychangu', max_length=50)),
                ('tx_ref', models.CharField(max_length=255, unique=True)),
                ('checkout_url', models.URLField(blank=True)),
                ('amount', models.DecimalField(decimal_places=2, max_digits=10, validators=[django.core.validators.MinValueValidator(Decimal('0.01'))])),
                ('currency', models.CharField(default='MWK', max_length=3)),
                ('status', models.CharField(choices=[('initiated', 'Initiated'), ('pending', 'Pending Checkout'), ('awaiting_verification', 'Awaiting Verification'), ('successful', 'Successful'), ('failed', 'Failed'), ('cancelled', 'Cancelled'), ('expired', 'Expired')], default='initiated', max_length=32)),
                ('provider_reference', models.CharField(blank=True, max_length=255)),
                ('callback_status', models.CharField(blank=True, max_length=50)),
                ('request_payload', models.JSONField(blank=True, default=dict)),
                ('response_payload', models.JSONField(blank=True, default=dict)),
                ('verification_payload', models.JSONField(blank=True, default=dict)),
                ('webhook_payload', models.JSONField(blank=True, default=dict)),
                ('last_error', models.TextField(blank=True)),
                ('paid_at', models.DateTimeField(blank=True, null=True)),
                ('verified_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('deposit', models.ForeignKey(on_delete=models.deletion.CASCADE, related_name='payment_attempts', to='subscription.deposit')),
                ('initiated_by', models.ForeignKey(blank=True, null=True, on_delete=models.deletion.SET_NULL, related_name='subscription_payment_attempts', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'Subscription Payment Attempt',
                'verbose_name_plural': 'Subscription Payment Attempts',
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='PaymentWebhookEvent',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('provider', models.CharField(choices=[('paychangu', 'PayChangu')], default='paychangu', max_length=50)),
                ('signature', models.CharField(blank=True, max_length=255)),
                ('event_type', models.CharField(blank=True, max_length=100)),
                ('tx_ref', models.CharField(blank=True, max_length=255)),
                ('is_valid_signature', models.BooleanField(default=False)),
                ('payload', models.JSONField(blank=True, default=dict)),
                ('processed', models.BooleanField(default=False)),
                ('processing_notes', models.TextField(blank=True)),
                ('processed_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('related_attempt', models.ForeignKey(blank=True, null=True, on_delete=models.deletion.SET_NULL, related_name='webhook_events', to='payments.subscriptionpaymentattempt')),
            ],
            options={
                'verbose_name': 'Payment Webhook Event',
                'verbose_name_plural': 'Payment Webhook Events',
                'ordering': ['-created_at'],
            },
        ),
    ]
