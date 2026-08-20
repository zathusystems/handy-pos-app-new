from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('subscription', '0015_alter_featurepricing_feature'),
    ]

    operations = [
        migrations.AddField(
            model_name='deposit',
            name='credited_amount',
            field=models.DecimalField(
                blank=True,
                decimal_places=2,
                help_text='Credits to add on completion. Defaults to the paid amount when blank.',
                max_digits=10,
                null=True,
            ),
        ),
        migrations.AddField(
            model_name='deposit',
            name='funding_period',
            field=models.CharField(
                blank=True,
                default='',
                help_text='Optional credit bundle type used to calculate bonus credits.',
                max_length=20,
            ),
        ),
    ]
