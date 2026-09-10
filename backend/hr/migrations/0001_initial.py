# Generated manually for the initial People & Payroll foundation.

import django.db.models.deletion
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('business', '0033_businesscharge_application_rule'),
        ('staff', '0011_alter_staff_role_add_kitchen_staff'),
    ]

    operations = [
        migrations.CreateModel(
            name='Employee',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('employee_number', models.PositiveIntegerField(editable=False)),
                ('first_name', models.CharField(max_length=100)),
                ('last_name', models.CharField(max_length=100)),
                ('email', models.EmailField(blank=True, max_length=254)),
                ('phone', models.CharField(blank=True, max_length=32)),
                ('address', models.TextField(blank=True)),
                ('emergency_contact_name', models.CharField(blank=True, max_length=255)),
                ('emergency_contact_phone', models.CharField(blank=True, max_length=32)),
                ('employment_status', models.CharField(choices=[('active', 'Active'), ('on_leave', 'On leave'), ('terminated', 'Terminated')], default='active', max_length=20)),
                ('started_on', models.DateField(blank=True, null=True)),
                ('ended_on', models.DateField(blank=True, null=True)),
                ('notes', models.TextField(blank=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='employees', to='business.business')),
                ('staff', models.OneToOneField(blank=True, help_text='Optional Handy POS login linked to this employee.', null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='employee_profile', to='staff.staff')),
            ],
            options={
                'ordering': ['last_name', 'first_name', 'employee_number'],
                'indexes': [models.Index(fields=['business', 'employment_status'], name='hr_employee_busines_32a4d4_idx'), models.Index(fields=['business', 'last_name', 'first_name'], name='hr_employee_busines_39774f_idx')],
            },
        ),
        migrations.CreateModel(
            name='EmployeeSequence',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('last_number', models.PositiveIntegerField(default=0)),
                ('business', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='employee_sequence', to='business.business')),
            ],
        ),
        migrations.CreateModel(
            name='EmploymentTerm',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('job_title', models.CharField(max_length=150)),
                ('department', models.CharField(blank=True, max_length=150)),
                ('employment_type', models.CharField(choices=[('full_time', 'Full time'), ('part_time', 'Part time'), ('contract', 'Contract'), ('casual', 'Casual')], default='full_time', max_length=20)),
                ('pay_frequency', models.CharField(choices=[('monthly', 'Monthly'), ('fortnightly', 'Fortnightly'), ('weekly', 'Weekly'), ('hourly', 'Hourly')], default='monthly', max_length=20)),
                ('base_salary', models.DecimalField(decimal_places=2, max_digits=14)),
                ('currency', models.CharField(default='MWK', max_length=3)),
                ('effective_from', models.DateField()),
                ('effective_to', models.DateField(blank=True, null=True)),
                ('notes', models.TextField(blank=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('branch', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='employment_terms', to='business.branch')),
                ('employee', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='employment_terms', to='hr.employee')),
            ],
            options={
                'ordering': ['-effective_from', '-created_at'],
                'indexes': [models.Index(fields=['employee', 'effective_from'], name='hr_employme_employe_08d2a8_idx'), models.Index(fields=['branch', 'effective_from'], name='hr_employme_branch__5cfc93_idx')],
            },
        ),
        migrations.AddConstraint(
            model_name='employee',
            constraint=models.UniqueConstraint(fields=('business', 'employee_number'), name='hr_unique_employee_number_per_business'),
        ),
        migrations.AddConstraint(
            model_name='employmentterm',
            constraint=models.UniqueConstraint(fields=('employee', 'effective_from'), name='hr_unique_employee_term_effective_date'),
        ),
        migrations.AddConstraint(
            model_name='employmentterm',
            constraint=models.CheckConstraint(condition=models.Q(('effective_to__isnull', True), ('effective_to__gte', models.F('effective_from')), _connector='OR'), name='hr_term_end_not_before_start'),
        ),
    ]
