from urllib.parse import urlparse

from django.core.exceptions import ValidationError


ALLOWED_REDIRECT_SCHEMES = {'http', 'https', 'handypos', 'ulendoapp'}


def validate_redirect_url(value, *, field_name='redirect_url'):
    redirect_url = str(value or '').strip()
    if not redirect_url:
        return ''

    parsed = urlparse(redirect_url)
    scheme = parsed.scheme.lower()
    if scheme not in ALLOWED_REDIRECT_SCHEMES:
        raise ValidationError(
            f'{field_name} must use http, https, handypos, or ulendoapp.'
        )

    if scheme in {'http', 'https'} and not parsed.netloc:
        raise ValidationError(
            f'{field_name} must include a valid host.'
        )

    if scheme in {'handypos', 'ulendoapp'} and not (
        parsed.netloc.strip() or parsed.path.strip('/')
    ):
        raise ValidationError(
            f'{field_name} must include an in-app route after the app scheme.'
        )

    return redirect_url
