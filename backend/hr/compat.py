"""Small ORM compatibility helpers for the supported Django versions."""

import django
from django.db import models


def check_constraint(*, condition, name):
    """Build a CheckConstraint for Django 4.2 through Django 6.

    Django 6 renamed the ``check`` constructor argument to ``condition``.
    Production currently uses Django 4.2, while local tooling may use Django 6.
    """
    keyword = 'condition' if django.VERSION >= (6, 0) else 'check'
    return models.CheckConstraint(**{keyword: condition, 'name': name})
