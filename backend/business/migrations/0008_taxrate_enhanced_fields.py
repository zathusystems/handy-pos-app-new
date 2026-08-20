# Generated migration for TaxRate model enhancements

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('business', '0007_alter_branch_id_alter_business_id_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='taxrate',
            name='tax_type',
            field=models.CharField(
                choices=[
                    ('VAT_STANDARD', 'VAT Standard Rated'),
                    ('VAT_ZERO', 'VAT Zero Rated'),
                    ('VAT_EXEMPT', 'VAT Exempt'),
                ],
                default='VAT_STANDARD',
                max_length=20,
            ),
        ),
        migrations.AddField(
            model_name='taxrate',
            name='effective_from',
            field=models.DateField(default='2024-01-01'),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name='taxrate',
            name='effective_to',
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='taxrate',
            name='is_active',
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name='taxrate',
            name='created_by',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AlterField(
            model_name='taxrate',
            name='rate',
            field=models.DecimalField(
                decimal_places=2,
                help_text='VAT percentage. Use 0.00 for zero-rated or exempt.',
                max_digits=5,
            ),
        ),
        migrations.AlterField(
            model_name='taxrate',
            name='is_default',
            field=models.BooleanField(
                default=False,
                help_text='Default VAT rate for taxable items',
            ),
        ),
        migrations.AlterModelOptions(
            name='taxrate',
            options={'ordering': ['-is_default', '-effective_from']},
        ),
        migrations.AddConstraint(
            model_name='taxrate',
            constraint=models.UniqueConstraint(
                condition=models.Q(('is_default', True), ('is_active', True)),
                fields=['business'],
                name='one_active_default_tax_per_business',
            ),
        ),
    ]
