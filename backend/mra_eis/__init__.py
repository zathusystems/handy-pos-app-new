"""
MRA EIS Integration App

A production-ready Django application for integrating with the Malawi Revenue Authority
Electronic Invoicing System (EIS).

Features:
- Terminal activation and management
- Configuration management
- Product mapping
- Invoice creation and submission
- Offline sales support
- Receipt generation with QR codes
- Comprehensive audit trails
- Error handling and resilience

Usage:
    from mra_eis.services import InvoiceService, TerminalService
    from mra_eis.models import Terminal, MRAInvoice

    # Activate terminal
    terminal = TerminalService.activate_terminal(...)

    # Create invoice
    invoice = InvoiceService.create_invoice(...)

    # Submit to MRA
    InvoiceService.submit_invoice(invoice)

Documentation:
    - MRA_EIS_IMPLEMENTATION.md - Full implementation guide
    - QUICK_START.md - Quick start guide
    - INTEGRATION_GUIDE.md - Integration with existing POS
    - DEPLOYMENT_GUIDE.md - Deployment guide
    - SETTINGS_TEMPLATE.md - Settings template

Version: 1.0.0
Status: Production Ready
"""

default_app_config = 'mra_eis.apps.MraEisConfig'

__version__ = '1.0.0'
__author__ = 'Handy POS Development Team'
__all__ = [
    'models',
    'services',
    'views',
    'serializers',
    'urls',
    'admin',
    'apps',
]
