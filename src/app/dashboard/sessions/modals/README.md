# Session Modals - Complete Reference

All session modals are now prepared and ready for use in the main session screen. This document provides a complete reference for each modal.

## Quick Start

```typescript
import {
  StartSessionForm,
  CloseSessionForm,
  SessionDetailDialog,
  SessionHistoryModal,
  SaleDetailModal,
} from '@/app/dashboard/sessions/modals';
```

## Modal Overview

### 1. StartSessionForm

**Purpose**: Multi-step form to start a new session

**Props**:
```typescript
{
  onSessionStarted: () => void  // Called when session is successfully created
}
```

**Features**:
- ✅ Step 1: Input opening cash float
- ✅ Step 2: Review opening inventory snapshot
- ✅ Backend sync with error handling
- ✅ Local DB storage for offline access
- ✅ Audit logging of session start
- ✅ Branch-aware (uses active branch from localStorage)

**Usage**:
```typescript
<Dialog open={isStartModalOpen} onOpenChange={setStartModalOpen}>
  <DialogTrigger asChild>
    <Button>Start New Session</Button>
  </DialogTrigger>
  <DialogContent className="sm:max-w-md">
    <DialogHeader>
      <DialogTitle>Start a New Session</DialogTitle>
    </DialogHeader>
    <StartSessionForm 
      onSessionStarted={() => {
        setStartModalOpen(false);
        fetchActiveSession(activeBranchId);
      }} 
    />
  </DialogContent>
</Dialog>
```

---

### 2. CloseSessionForm

**Purpose**: Form to close an active session with cash reconciliation

**Props**:
```typescript
{
  session: Session;              // The active session to close
  onSessionClosed: () => void    // Called when session is successfully closed
}
```

**Features**:
- ✅ Sales summary display (all payment methods)
- ✅ Cash reconciliation with real-time difference calculation
- ✅ Closing stock snapshot
- ✅ Backend sync with error handling
- ✅ Local DB update
- ✅ Audit logging of session close
- ✅ Visual feedback (green if balanced, red if not)

**Usage**:
```typescript
<Dialog open={isCloseModalOpen} onOpenChange={setCloseModalOpen}>
  <DialogTrigger asChild>
    <Button variant="destructive">Close Session</Button>
  </DialogTrigger>
  <DialogContent className="max-h-[90vh] flex flex-col sm:max-w-md">
    <DialogHeader>
      <DialogTitle>Close Current Session</DialogTitle>
    </DialogHeader>
    <div className="flex-1 overflow-y-auto min-h-0">
      <CloseSessionForm 
        session={activeSession} 
        onSessionClosed={() => {
          setCloseModalOpen(false);
          fetchActiveSession(activeBranchId);
        }} 
      />
    </div>
  </DialogContent>
</Dialog>
```

---

### 3. SessionDetailDialog

**Purpose**: Read-only dialog showing detailed session information

**Props**:
```typescript
{
  session: Session;                    // The session to display
  isOpen: boolean;                     // Controls visibility
  onOpenChange: (open: boolean) => void // Visibility callback
}
```

**Features**:
- ✅ Summary tab: Sales summary and cash reconciliation
- ✅ Stock Reconciliation tab: Opening vs closing stock comparison
- ✅ Read-only display (no editing)
- ✅ Tabbed interface for organization

**Usage**:
```typescript
const [viewingSession, setViewingSession] = useState<Session | null>(null);

<SessionDetailDialog 
  session={viewingSession}
  isOpen={!!viewingSession}
  onOpenChange={(open) => !open && setViewingSession(null)}
/>
```

---

### 4. SessionHistoryModal

**Purpose**: Modal to view and drill into closed sessions

**Props**:
```typescript
{
  isOpen: boolean;                     // Controls visibility
  onOpenChange: (open: boolean) => void // Visibility callback
}
```

**Features**:
- ✅ List of closed sessions with key metrics
- ✅ Drill-down into individual session details
- ✅ Summary tab: Sales and cash reconciliation
- ✅ Sales tab: View all orders with drill-down to order details
- ✅ Stock tab: Stock reconciliation for the session
- ✅ Backend sync with local DB fallback
- ✅ Automatic branch filtering
- ✅ Loading states and error handling

**Usage**:
```typescript
const [isHistoryModalOpen, setHistoryModalOpen] = useState(false);

<Button variant="outline" onClick={() => setHistoryModalOpen(true)}>
  <History className="mr-2 h-4 w-4" /> History
</Button>

<SessionHistoryModal 
  isOpen={isHistoryModalOpen} 
  onOpenChange={setHistoryModalOpen} 
/>
```

---

### 5. SaleDetailModal

**Purpose**: Modal to view detailed order/sale information

**Props**:
```typescript
{
  order: Order | null;                 // The order to display (null hides modal)
  isOpen: boolean;                     // Controls visibility
  onOpenChange: (open: boolean) => void // Visibility callback
}
```

**Features**:
- ✅ Item breakdown with quantities and notes
- ✅ Payment method and status display
- ✅ Subtotal, tax, and total calculations
- ✅ Cost of Goods Sold (COGS) display
- ✅ MRA EIS status and fiscal invoice number
- ✅ Formatted currency display

**Usage**:
```typescript
const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

<SaleDetailModal 
  order={selectedOrder}
  isOpen={!!selectedOrder}
  onOpenChange={(open) => !open && setSelectedOrder(null)}
/>

// Trigger from table row click
<TableRow 
  onClick={() => setSelectedOrder(order)}
  className="cursor-pointer hover:bg-muted/50"
>
  {/* ... */}
</TableRow>
```

---

## Integration Checklist

- [x] All modals export as default functions
- [x] All modals have proper TypeScript types
- [x] All modals handle loading states
- [x] All modals have error handling with toast notifications
- [x] All modals support offline mode with local DB fallback
- [x] All modals are branch-aware
- [x] All modals include audit logging
- [x] All modals use proper styling and spacing
- [x] All modals have proper accessibility
- [x] Index file exports all modals
- [x] Usage guide provided

## Key Behaviors

### Branch Awareness
All modals automatically:
- Read active branch from `localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH)`
- Listen to `branchChanged` custom events
- Filter data by branch
- Update when branch changes

### Offline Support
All modals:
- Sync data to local Dexie DB
- Fall back to local DB if backend fails
- Work seamlessly offline
- Sync when connection restored

### Audit Logging
Session modals log:
- `SESSION_START` when session created
- `SESSION_END` when session closed
- User info, branch info, and action details
- Timestamps for all actions

### Error Handling
All modals:
- Show toast notifications for errors
- Log errors to console for debugging
- Gracefully handle network failures
- Provide user-friendly error messages

## Data Flow

```
User Action
    ↓
Modal Component
    ↓
Form Submission
    ↓
Backend API Call (with error handling)
    ↓
Local DB Update
    ↓
Audit Logging
    ↓
Toast Notification
    ↓
Callback to Parent
    ↓
Parent Refreshes Data
```

## Common Patterns

### Pattern 1: Modal with Dialog Wrapper
```typescript
const [isOpen, setIsOpen] = useState(false);

<Dialog open={isOpen} onOpenChange={setIsOpen}>
  <DialogTrigger asChild>
    <Button>Open Modal</Button>
  </DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Modal Title</DialogTitle>
    </DialogHeader>
    <ModalComponent 
      onSuccess={() => setIsOpen(false)}
    />
  </DialogContent>
</Dialog>
```

### Pattern 2: Controlled Modal
```typescript
const [selectedItem, setSelectedItem] = useState<Item | null>(null);

<Modal 
  item={selectedItem}
  isOpen={!!selectedItem}
  onOpenChange={(open) => !open && setSelectedItem(null)}
/>
```

### Pattern 3: Nested Navigation
```typescript
// List view
<SessionHistoryModal isOpen={isOpen} onOpenChange={setIsOpen} />

// Inside: Click session -> SessionDetailDialog
// Inside: Click order -> SaleDetailModal
```

## File Structure

```
/src/app/dashboard/sessions/modals/
├── index.ts                      # Main export file
├── start-session-modal.tsx       # Start session form
├── close-session-modal.tsx       # Close session form
├── session-detail-modal.tsx      # Session detail dialog
├── session-history-modal.tsx     # Session history modal
├── sale-detail-modal.tsx         # Sale detail modal
├── USAGE_GUIDE.md               # Detailed usage guide
└── README.md                     # This file
```

## Dependencies

All modals depend on:
- React hooks (useState, useEffect, useMemo)
- react-hook-form (for forms)
- dexie-react-hooks (for local DB)
- date-fns (for date formatting)
- uuid (for ID generation)
- Custom hooks: useAuth, useCurrency, useToast
- UI components: Dialog, Button, Card, Table, etc.
- Services: authFetch, logAuditAction, syncService

## Testing

To test the modals:

1. **Start Session**
   - Click "Start New Session"
   - Enter opening float
   - Review inventory
   - Confirm

2. **Close Session**
   - Click "Close Session"
   - Enter actual cash counted
   - Verify difference calculation
   - Confirm

3. **View History**
   - Click "History"
   - Click on a session
   - View details and drill down

4. **View Order Details**
   - Click on an order in sales list
   - View order details

## Troubleshooting

### Modal not opening
- Check if `isOpen` prop is true
- Verify `onOpenChange` callback is working
- Check browser console for errors

### Data not loading
- Check network tab for API calls
- Verify branch ID is set correctly
- Check local DB in DevTools

### Offline mode not working
- Verify Dexie DB is initialized
- Check if data was synced before going offline
- Check browser storage quota

## Future Enhancements

- [ ] Export session data to PDF
- [ ] Email session reports
- [ ] Bulk session operations
- [ ] Advanced filtering and search
- [ ] Session comparison reports
- [ ] Real-time sync with WebSockets
- [ ] Mobile-optimized views

## Support

For issues or questions:
1. Check the USAGE_GUIDE.md
2. Review console logs
3. Check network requests
4. Verify data in local DB
5. Contact development team
