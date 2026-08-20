# Generated for customer laybuy support

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('pos_sessions', '0012_order_customer'),
    ]

    operations = [
        migrations.AlterField(
            model_name='order',
            name='payment_method',
            field=models.CharField(choices=[('Cash', 'Cash'), ('Card', 'Card'), ('Mobile Money', 'Mobile Money'), ('On Account', 'On Account'), ('Laybuy', 'Laybuy'), ('Other', 'Other')], max_length=20),
        ),
    ]
