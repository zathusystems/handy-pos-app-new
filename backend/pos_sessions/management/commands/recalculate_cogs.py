from __future__ import annotations

from decimal import Decimal
from typing import Optional

from django.core.management.base import BaseCommand
from django.utils import timezone

from inventory.models import InventoryItem, PurchaseOrderItem
from pos_sessions.models import Order


class Command(BaseCommand):
    help = (
        "Recalculate order COGS using purchase history. "
        "Uses latest or weighted-average purchase cost (net of VAT) as of the order date."
    )

    def add_arguments(self, parser):
        parser.add_argument('--business-id', type=str, help='Filter by business id')
        parser.add_argument('--branch-id', type=str, help='Filter by branch id')
        parser.add_argument('--from-date', type=str, help='ISO date (inclusive)')
        parser.add_argument('--to-date', type=str, help='ISO date (inclusive)')
        parser.add_argument(
            '--method',
            choices=['latest', 'average'],
            default='latest',
            help='Cost method to use from purchase history',
        )
        parser.add_argument('--force', action='store_true', help='Recalculate even if cogs is already set')
        parser.add_argument('--dry-run', action='store_true', help='Only report changes without saving')
        parser.add_argument('--limit', type=int, help='Limit number of orders processed')

    def handle(self, *args, **options):
        business_id = options.get('business_id')
        branch_id = options.get('branch_id')
        from_date = options.get('from_date')
        to_date = options.get('to_date')
        method = options.get('method')
        force = options.get('force')
        dry_run = options.get('dry_run')
        limit = options.get('limit')

        qs = Order.objects.all().prefetch_related('items')
        if business_id:
            qs = qs.filter(business_id=business_id)
        if branch_id:
            qs = qs.filter(branch_id=branch_id)
        if from_date:
            qs = qs.filter(created_at__gte=from_date)
        if to_date:
            qs = qs.filter(created_at__lte=to_date)

        if limit:
            qs = qs.order_by('-created_at')[:limit]

        updated = 0
        skipped = 0

        for order in qs:
            if not force and order.cogs and order.cogs > 0:
                skipped += 1
                continue

            order_cogs = Decimal('0.00')
            order_date = order.created_at or timezone.now()

            for item in order.items.all():
                quantity = item.quantity or Decimal('0')
                if quantity <= 0:
                    continue

                net_unit_cost = self._resolve_net_unit_cost(
                    inventory_item_id=item.inventory_item_id,
                    branch_id=str(order.branch_id),
                    business_id=str(order.business_id),
                    order_date=order_date,
                    method=method,
                )
                order_cogs += net_unit_cost * quantity

            order_cogs = order_cogs.quantize(Decimal('0.01'))

            if dry_run:
                self.stdout.write(
                    f"[DRY RUN] Order {order.id} -> COGS {order.cogs} => {order_cogs}"
                )
            else:
                order.cogs = order_cogs
                order.save(update_fields=['cogs'])
                self.stdout.write(f"Updated order {order.id}: cogs={order_cogs}")
                updated += 1

        self.stdout.write(
            f"COGS recalculation complete. Updated: {updated}, Skipped: {skipped}, Dry-run: {dry_run}"
        )

    def _resolve_net_unit_cost(
        self,
        inventory_item_id: str,
        branch_id: str,
        business_id: str,
        order_date,
        method: str,
    ) -> Decimal:
        purchase_qs = PurchaseOrderItem.objects.filter(
            inventory_item_id=inventory_item_id,
            purchase_order__branch_id=branch_id,
            purchase_order__business_id=business_id,
        )

        if order_date:
            purchase_qs = purchase_qs.filter(created_at__lte=order_date)

        if method == 'latest':
            purchase_item = purchase_qs.order_by('-created_at').first()
            if purchase_item:
                return self._net_cost_from_purchase_item(purchase_item)
        else:
            total_qty = Decimal('0.00')
            total_value = Decimal('0.00')
            for purchase_item in purchase_qs:
                qty = purchase_item.quantity_received or purchase_item.quantity_ordered or Decimal('0')
                if qty <= 0:
                    continue
                unit_cost = self._net_cost_from_purchase_item(purchase_item)
                total_qty += qty
                total_value += unit_cost * qty
            if total_qty > 0:
                return total_value / total_qty

        # Fallback to inventory cost (already net if updated via purchase flow)
        inventory_cost = InventoryItem.objects.filter(id=inventory_item_id).values_list('cost', flat=True).first()
        if inventory_cost is None:
            return Decimal('0.00')
        return Decimal(str(inventory_cost))

    @staticmethod
    def _net_cost_from_purchase_item(purchase_item: PurchaseOrderItem) -> Decimal:
        gross_unit = purchase_item.cost_per_unit or Decimal('0')
        rate = purchase_item.tax_rate or Decimal('0')
        if rate <= 0:
            return gross_unit
        divisor = Decimal('1') + (rate / Decimal('100'))
        if divisor <= 0:
            return gross_unit
        return gross_unit / divisor
