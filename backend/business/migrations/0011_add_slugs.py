# Migration to add slug fields to Business and Branch with auto-generation

from django.db import migrations, models
from django.utils.text import slugify


def generate_slugs_business(apps, schema_editor):
    """Generate slugs for existing businesses"""
    Business = apps.get_model('business', 'Business')
    slug_counter = {}
    
    for business in Business.objects.all().order_by('created_at'):
        base_slug = slugify(business.name)
        
        # Track how many times we've seen this base slug
        if base_slug not in slug_counter:
            slug_counter[base_slug] = 0
            slug = base_slug
        else:
            slug_counter[base_slug] += 1
            slug = f"{base_slug}-{slug_counter[base_slug]}"
        
        business.slug = slug
        business.save(update_fields=['slug'])


def generate_slugs_branch(apps, schema_editor):
    """Generate slugs for existing branches"""
    Branch = apps.get_model('business', 'Branch')
    
    for branch in Branch.objects.all().order_by('created_at'):
        base_slug = slugify(branch.name)
        slug = base_slug
        counter = 1
        
        # Ensure unique slug within the business
        while Branch.objects.filter(
            business=branch.business,
            slug=slug
        ).exclude(pk=branch.pk).exists():
            slug = f"{base_slug}-{counter}"
            counter += 1
        
        branch.slug = slug
        branch.save(update_fields=['slug'])


class Migration(migrations.Migration):

    dependencies = [
        ('business', '0010_expense_invoice_approval_status_invoice_approved_at_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='business',
            name='slug',
            field=models.SlugField(blank=True, db_index=False, max_length=255, null=True),
        ),
        migrations.AddField(
            model_name='branch',
            name='slug',
            field=models.SlugField(blank=True, db_index=False, max_length=255, null=True),
        ),
        migrations.RunPython(generate_slugs_business),
        migrations.RunPython(generate_slugs_branch),
        # Now make slug unique and non-nullable
        migrations.AlterField(
            model_name='business',
            name='slug',
            field=models.SlugField(max_length=255, unique=True),
        ),
        migrations.AlterField(
            model_name='branch',
            name='slug',
            field=models.SlugField(max_length=255),
        ),
        migrations.AlterUniqueTogether(
            name='branch',
            unique_together={('business', 'slug')},
        ),
    ]
