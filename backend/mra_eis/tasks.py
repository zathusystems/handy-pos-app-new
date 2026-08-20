"""
Celery tasks for MRA EIS background processing.
"""
from __future__ import annotations

from celery import shared_task
from django.db.models import Q

from .models import Terminal
from .services import InvoiceService, RetryService


@shared_task
def process_mra_retry_queue():
    """Process queued retry jobs for MRA EIS (POS orders, invoices, offline sync)."""
    RetryService.process_retry_queue()
    return {'status': 'ok'}


@shared_task
def sync_offline_invoices_for_online_terminals():
    """
    Sync offline invoices for terminals that are active + online.
    Intended to be scheduled periodically (Celery beat or cron).
    """
    terminals = Terminal.objects.filter(
        Q(status='active') & Q(is_online=True)
    )

    synced_total = 0
    failed_total = 0

    for terminal in terminals:
        try:
            result = InvoiceService.sync_offline_invoices(terminal)
            synced_total += int(result.get('synced', 0))
            failed_total += int(result.get('failed', 0))
        except Exception:
            failed_total += 1

    return {
        'terminals': terminals.count(),
        'synced': synced_total,
        'failed': failed_total,
    }
