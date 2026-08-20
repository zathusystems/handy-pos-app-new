import type { PurchaseRecord } from '@/lib/db';

export interface EditablePurchaseGroup {
    groupId: string;
    purchaseOrderId?: string;
    receivedDate: string;
    supplierId?: string;
    supplierName: string;
    paymentStatus: PurchaseRecord['paymentStatus'];
    referenceNumber?: string;
    vatAmount?: number;
    items: PurchaseRecord[];
}
