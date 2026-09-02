from django.db import migrations, models
import django.db.models.deletion
from django.core.validators import MinValueValidator
import uuid


class Migration(migrations.Migration):

    dependencies = [
        ('mra_eis', '0005_alter_syncretryqueue_operation_type'),
    ]

    operations = [
        migrations.CreateModel(
            name='FiscalInvoiceSequence',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('julian_date', models.PositiveIntegerField(help_text='MRA Julian date represented by this sequence.')),
                ('last_sequence', models.BigIntegerField(default=0, validators=[MinValueValidator(0)])),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('terminal', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='fiscal_sequences', to='mra_eis.terminal')),
            ],
            options={
                'ordering': ['-julian_date'],
                'unique_together': {('terminal', 'julian_date')},
            },
        ),
        migrations.AddField(
            model_name='mrainvoice',
            name='fiscal_invoice_number',
            field=models.CharField(blank=True, help_text='Full MRA fiscal invoice number, when available.', max_length=100),
        ),
        migrations.AddField(
            model_name='mrainvoice',
            name='fiscal_julian_date',
            field=models.PositiveIntegerField(blank=True, help_text='MRA Julian date used for fiscal sequencing.', null=True),
        ),
        migrations.AlterUniqueTogether(
            name='mrainvoice',
            unique_together={
                ('terminal', 'invoice_number', 'is_online'),
                ('terminal', 'fiscal_julian_date', 'invoice_number'),
            },
        ),
        migrations.AddIndex(
            model_name='mrainvoice',
            index=models.Index(fields=['terminal', 'fiscal_julian_date', 'invoice_number'], name='mra_eis_mra_term_fisc_8dd85c_idx'),
        ),
    ]
