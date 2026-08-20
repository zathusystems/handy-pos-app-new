// @ts-nocheck
/**
 * Example usage of authenticated fetch with offline-first support
 * 
 * This file demonstrates how to use the auth-fetch utility and hooks
 * throughout the Handy POS system.
 */

// ============================================================================
// 1. BASIC API CALLS WITH useApi HOOK
// ============================================================================

import { useApi, useAuth, useSyncQueue } from '@/hooks/use-api';

// Fetch businesses
export function BusinessList() {
  const { data: businesses, loading, error, refetch } = useApi('/business/businesses/');

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      {businesses?.map((b: any) => (
        <div key={b.id}>{b.name}</div>
      ))}
      <button onClick={refetch}>Refresh</button>
    </div>
  );
}

// ============================================================================
// 2. MUTATIONS (CREATE, UPDATE, DELETE)
// ============================================================================

export function CreateStaffForm() {
  const { mutate, loading, error } = useApi('/staff/staff/', {
    onSuccess: (data) => console.log('Staff created:', data),
    onError: (error) => console.error('Failed to create staff:', error),
  });

  const handleSubmit = async (formData: any) => {
    const result = await mutate('POST', formData);
    if (result) {
      console.log('Success!');
    }
  };

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      handleSubmit({ name: 'John', email: 'john@example.com', role: 'Cashier' });
    }}>
      <button type="submit" disabled={loading}>
        {loading ? 'Creating...' : 'Create Staff'}
      </button>
      {error && <p style={{ color: 'red' }}>{error.message}</p>}
    </form>
  );
}

// ============================================================================
// 3. AUTHENTICATION
// ============================================================================

export function LoginForm() {
  const { login, loading, error, isAuthenticated } = useAuth();

  const handleLogin = async (email: string, password: string) => {
    try {
      await login(email, password);
      console.log('Logged in successfully');
    } catch (err) {
      console.error('Login failed:', err);
    }
  };

  if (isAuthenticated) {
    return <div>Already logged in</div>;
  }

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      handleLogin('user@example.com', 'password123');
    }}>
      <button type="submit" disabled={loading}>
        {loading ? 'Logging in...' : 'Login'}
      </button>
      {error && <p style={{ color: 'red' }}>{error.message}</p>}
    </form>
  );
}

// ============================================================================
// 4. OFFLINE-FIRST SYNC MONITORING
// ============================================================================

export function SyncStatus() {
  const { count, isOnline, hasPendingSync } = useSyncQueue();

  return (
    <div>
      <p>Status: {isOnline ? '🟢 Online' : '🔴 Offline'}</p>
      {hasPendingSync && (
        <p>Pending syncs: {count}</p>
      )}
    </div>
  );
}

// ============================================================================
// 5. OFFLINE-FIRST OPERATIONS
// ============================================================================

export function OfflineFirstExample() {
  const { mutate, loading, error, isOnline, syncQueueCount } = useApi(
    '/business/businesses/',
    {
      offline: true, // Enable offline mode
      onSuccess: (data) => console.log('Synced:', data),
    }
  );

  const handleCreateOffline = async () => {
    // This will queue the request if offline
    const result = await mutate('POST', {
      name: 'New Business',
      business_type: 'restaurant',
    });
    
    if (!isOnline) {
      console.log('Request queued for sync when online');
    }
  };

  return (
    <div>
      <button onClick={handleCreateOffline} disabled={loading}>
        Create Business
      </button>
      {!isOnline && syncQueueCount > 0 && (
        <p>Waiting to sync {syncQueueCount} requests...</p>
      )}
      {error && <p style={{ color: 'red' }}>{error.message}</p>}
    </div>
  );
}

// ============================================================================
// 6. DIRECT authFetch USAGE (Advanced)
// ============================================================================

import { authFetch } from '@/lib/auth-fetch';

export async function directFetchExample() {
  try {
    // GET request
    const businesses = await authFetch.fetch('/business/businesses/');
    console.log('Businesses:', businesses);

    // POST request
    const newBusiness = await authFetch.fetch('/business/businesses/', {
      method: 'POST',
      body: JSON.stringify({
        name: 'My Restaurant',
        business_type: 'restaurant',
      }),
    });
    console.log('Created:', newBusiness);

    // PUT request
    const updated = await authFetch.fetch('/business/businesses/1/', {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Updated Name',
      }),
    });
    console.log('Updated:', updated);

    // DELETE request
    await authFetch.fetch('/business/businesses/1/', {
      method: 'DELETE',
    });
    console.log('Deleted');

    // Check authentication
    if (authFetch.isAuthenticated()) {
      console.log('User is authenticated');
    }

    // Get sync queue status
    const syncStatus = authFetch.getSyncQueueStatus();
    console.log('Pending syncs:', syncStatus.count);

    // Get online status
    const isOnline = authFetch.getOnlineStatus();
    console.log('Is online:', isOnline);

  } catch (error) {
    console.error('API Error:', error);
  }
}

// ============================================================================
// 7. INTEGRATION WITH DEXIE (Offline-First Database)
// ============================================================================

import { db } from '@/lib/db';

export async function syncDataWithBackend() {
  try {
    // Fetch from backend
    const staffList = await authFetch.fetch('/staff/staff/');
    
    // Store in local Dexie database
    await db.staff.bulkPut(staffList);
    
    console.log('Synced staff to local database');
  } catch (error) {
    console.error('Sync failed:', error);
    // Fall back to local data
    const localStaff = await db.staff.toArray();
    console.log('Using local data:', localStaff);
  }
}

// ============================================================================
// 8. COMPLETE EXAMPLE: STAFF MANAGEMENT WITH OFFLINE SUPPORT
// ============================================================================

export function StaffManagementExample() {
  const { data: staffList, loading, error, mutate, refetch } = useApi('/staff/staff/');
  const { isOnline, hasPendingSync, count } = useSyncQueue();

  const handleAddStaff = async (formData: any) => {
    const result = await mutate('POST', formData);
    if (result) {
      refetch(); // Refresh the list
    }
  };

  const handleDeleteStaff = async (staffId: string) => {
    await mutate('DELETE', undefined); // DELETE doesn't need body
    refetch();
  };

  return (
    <div>
      <div style={{ marginBottom: '20px' }}>
        <p>Status: {isOnline ? '🟢 Online' : '🔴 Offline'}</p>
        {hasPendingSync && <p>Syncing {count} changes...</p>}
      </div>

      {loading && <p>Loading staff...</p>}
      {error && <p style={{ color: 'red' }}>Error: {error.message}</p>}

      <div>
        {staffList?.map((staff: any) => (
          <div key={staff.id}>
            <p>{staff.name} - {staff.role}</p>
            <button onClick={() => handleDeleteStaff(staff.id)}>Delete</button>
          </div>
        ))}
      </div>

      <button onClick={() => handleAddStaff({ name: 'New Staff', email: 'staff@example.com', role: 'Cashier' })}>
        Add Staff
      </button>
    </div>
  );
}
