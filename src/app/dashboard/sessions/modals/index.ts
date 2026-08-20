/**
 * Session Modals Index
 * 
 * This file exports all session-related modals ready for use in the main session screen.
 * Each modal is a self-contained component that handles its own state and logic.
 * 
 * Usage:
 * import { 
 *   StartSessionForm, 
 *   CloseSessionForm, 
 *   SessionDetailDialog, 
 *   SessionHistoryModal, 
 *   SaleDetailModal 
 * } from '@/app/dashboard/sessions/modals';
 */

export { default as StartSessionForm } from './start-session-modal';
export { default as CloseSessionForm } from './close-session-modal';
export { default as SessionDetailDialog } from './session-detail-modal';
export { default as SessionHistoryModal } from './session-history-modal';
export { default as SaleDetailModal } from './sale-detail-modal';
export { CreditNoteModal } from './credit-note-modal';
export { DebitNoteModal } from './debit-note-modal';
export { VoidModal } from './void-modal';

/**
 * Modal Types and Interfaces
 */
export type { Session, Order } from '@/lib/db';

/**
 * Modal Configuration
 * 
 * Each modal has the following characteristics:
 * 
 * 1. StartSessionForm
 *    - Props: { onSessionStarted: () => void }
 *    - Purpose: Multi-step form to start a new session with opening float and inventory review
 *    - Features: Opening float input, inventory snapshot, backend sync, audit logging
 * 
 * 2. CloseSessionForm
 *    - Props: { session: Session; onSessionClosed: () => void }
 *    - Purpose: Form to close an active session with cash reconciliation
 *    - Features: Cash counting, difference calculation, sales summary, backend sync, audit logging
 * 
 * 3. SessionDetailDialog
 *    - Props: { session: Session; isOpen: boolean; onOpenChange: (open: boolean) => void }
 *    - Purpose: Read-only dialog showing detailed session information
 *    - Features: Sales summary, cash reconciliation, stock reconciliation tabs
 * 
 * 4. SessionHistoryModal
 *    - Props: { isOpen: boolean; onOpenChange: (open: boolean) => void }
 *    - Purpose: Modal to view and drill into closed sessions
 *    - Features: Session list, detailed session view, sales drill-down, stock reconciliation
 * 
 * 5. SaleDetailModal
 *    - Props: { order: Order | null; isOpen: boolean; onOpenChange: (open: boolean) => void }
 *    - Purpose: Modal to view detailed order/sale information
 *    - Features: Item breakdown, payment method, totals, COGS, EIS status
 */
