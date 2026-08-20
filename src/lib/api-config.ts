/**
 * API Configuration for Desktop App
 * 
 * This file provides centralized API endpoint configuration
 * that works with the configured Handy POS backend
 */

// Detect environment
const isDesktop = typeof window !== 'undefined' && 
  (process.env.NEXT_PUBLIC_APP_ENV === 'desktop' || 
   process.env.NEXT_PUBLIC_USE_LOCAL_BACKEND === 'true');

// API Base URL
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.handypos.online/api';
export const DJANGO_URL = process.env.NEXT_PUBLIC_DJANGO_URL || 'https://api.handypos.online';

// API Endpoints
export const API_ENDPOINTS = {
  // Authentication
  auth: {
    login: `${API_BASE_URL}/auth/login/`,
    logout: `${API_BASE_URL}/auth/logout/`,
    register: `${API_BASE_URL}/auth/register/`,
    refresh: `${API_BASE_URL}/auth/refresh/`,
    profile: `${API_BASE_URL}/auth/profile/`,
  },

  // Business
  business: {
    list: `${API_BASE_URL}/business/`,
    detail: (id: string) => `${API_BASE_URL}/business/${id}/`,
    create: `${API_BASE_URL}/business/`,
    update: (id: string) => `${API_BASE_URL}/business/${id}/`,
    delete: (id: string) => `${API_BASE_URL}/business/${id}/`,
  },

  // Inventory
  inventory: {
    items: `${API_BASE_URL}/inventory/items/`,
    item: (id: string) => `${API_BASE_URL}/inventory/items/${id}/`,
    categories: `${API_BASE_URL}/inventory/categories/`,
    suppliers: `${API_BASE_URL}/inventory/suppliers/`,
    stock: `${API_BASE_URL}/inventory/stock/`,
  },

  // POS Sessions
  sessions: {
    list: `${API_BASE_URL}/sessions/`,
    detail: (id: string) => `${API_BASE_URL}/sessions/${id}/`,
    create: `${API_BASE_URL}/sessions/`,
    orders: `${API_BASE_URL}/sessions/orders/`,
    close: (id: string) => `${API_BASE_URL}/sessions/${id}/close/`,
  },

  // Sales & Reports
  sales: {
    list: `${API_BASE_URL}/sales/`,
    reports: `${API_BASE_URL}/sales/reports/`,
    daily: `${API_BASE_URL}/sales/daily/`,
    monthly: `${API_BASE_URL}/sales/monthly/`,
  },

  // Expenses
  expenses: {
    list: `${API_BASE_URL}/expenses/`,
    detail: (id: string) => `${API_BASE_URL}/expenses/${id}/`,
    create: `${API_BASE_URL}/expenses/`,
    categories: `${API_BASE_URL}/expenses/categories/`,
  },

  // Staff
  staff: {
    list: `${API_BASE_URL}/staff/`,
    detail: (id: string) => `${API_BASE_URL}/staff/${id}/`,
    create: `${API_BASE_URL}/staff/`,
    roles: `${API_BASE_URL}/staff/roles/`,
  },

  // Settings
  settings: {
    get: `${API_BASE_URL}/settings/`,
    update: `${API_BASE_URL}/settings/`,
  },
};

/**
 * Fetch wrapper with error handling
 */
export async function apiCall<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const defaultOptions: RequestInit = {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include', // Include cookies for CSRF
  };

  try {
    const response = await fetch(endpoint, {
      ...defaultOptions,
      ...options,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        detail: `HTTP ${response.status}`,
      }));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`API Error [${endpoint}]:`, error);
    throw error;
  }
}

/**
 * GET request
 */
export function apiGet<T>(endpoint: string): Promise<T> {
  return apiCall<T>(endpoint, { method: 'GET' });
}

/**
 * POST request
 */
export function apiPost<T>(endpoint: string, data: any): Promise<T> {
  return apiCall<T>(endpoint, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * PUT request
 */
export function apiPut<T>(endpoint: string, data: any): Promise<T> {
  return apiCall<T>(endpoint, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/**
 * PATCH request
 */
export function apiPatch<T>(endpoint: string, data: any): Promise<T> {
  return apiCall<T>(endpoint, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

/**
 * DELETE request
 */
export function apiDelete<T>(endpoint: string): Promise<T> {
  return apiCall<T>(endpoint, { method: 'DELETE' });
}

/**
 * Check if backend is available
 */
export async function checkBackendHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${DJANGO_URL}/health/`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get API status
 */
export async function getApiStatus(): Promise<{
  available: boolean;
  url: string;
  environment: string;
}> {
  return {
    available: await checkBackendHealth(),
    url: DJANGO_URL,
    environment: isDesktop ? 'desktop' : 'web',
  };
}

export default {
  API_BASE_URL,
  DJANGO_URL,
  API_ENDPOINTS,
  apiCall,
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
  checkBackendHealth,
  getApiStatus,
};
