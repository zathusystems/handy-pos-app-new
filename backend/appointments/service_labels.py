from collections.abc import Mapping


def format_appointment_service_label(service):
    """Return the appointment service name with its chosen options, if any."""
    if not isinstance(service, Mapping):
        return ''

    service_name = str(service.get('name') or '').strip()
    if not service_name:
        return ''

    raw_options = service.get('selected_options') or service.get('selectedOptions') or []
    option_names = []
    if isinstance(raw_options, list):
        for option in raw_options:
            if not isinstance(option, Mapping):
                continue
            option_name = str(option.get('name') or option.get('label') or '').strip()
            if option_name and option_name not in option_names:
                option_names.append(option_name)

    if not option_names:
        return service_name
    return f"{service_name} - {', '.join(option_names)}"
