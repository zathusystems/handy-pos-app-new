import { db } from './db';

export interface AuthTokens {
  access: string;
  refresh: string;
}

export type QueueDomain =
  | 'settings'
  | 'inventory'
  | 'sales'
  | 'purchases'
  | 'expenses'
  | 'customers'
  | 'suppliers'
  | 'sessions'
  | 'kitchen'
  | 'reports'
  | 'other';

export interface SyncQueueItem {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  body?: any;
  timestamp: number;
  retries: number;
  maxRetries: number;
  error?: string;
  domain?: QueueDomain;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, any>;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://api.handypos.online/api';
const SYNC_QUEUE_KEY = 'handypos-sync-queue';
const SYNC_QUEUE_MIGRATION_KEY = 'handypos-sync-queue-migrated-v1';
const AUTH_TOKENS_KEY = 'handypos-auth-tokens';
const DEVICE_SERIAL_KEY = 'handypos-device-serial';
const LEGACY_DEVICE_SERIAL_KEY = 'handypos-eis-device-serial';
const MAX_RETRIES = 3;
const SYNC_INTERVAL = 30000; // 30 seconds
const TRANSIENT_NETWORK_RETRY_DELAY_MS = 800;

const getDeviceSerial = (): string => {
  if (typeof window === 'undefined') return '';
  try {
    const existing =
      localStorage.getItem(DEVICE_SERIAL_KEY) || localStorage.getItem(LEGACY_DEVICE_SERIAL_KEY);
    if (existing) {
      localStorage.setItem(DEVICE_SERIAL_KEY, existing);
      return existing;
    }

    const userAgent = window.navigator.userAgent.toLowerCase();
    const os = userAgent.includes('android')
      ? 'AND'
      : userAgent.includes('win')
        ? 'WIN'
        : userAgent.includes('mac')
          ? 'MAC'
          : userAgent.includes('linux')
            ? 'LNX'
            : 'WEB';
    const serial = `HANDY-${os}-${Date.now().toString(36).toUpperCase()}`;
    localStorage.setItem(DEVICE_SERIAL_KEY, serial);
    return serial;
  } catch {
    return '';
  }
};

class AuthenticatedFetch {
  private tokens: AuthTokens | null = null;
  private syncQueue: SyncQueueItem[] = [];
  private isOnline: boolean = typeof navigator !== 'undefined' ? navigator.onLine : true;
  private syncIntervalId: NodeJS.Timeout | null = null;

  constructor() {
    // Only initialize on client side
    if (typeof window === 'undefined') return;
    
    this.loadTokens();
    this.loadSyncQueue();
    this.runOneTimeQueueMigration();
    this.setupNetworkListeners();
    this.startSyncInterval();
  }

  /**
   * Load tokens from localStorage
   */
  private loadTokens(): void {
    if (typeof window === 'undefined') return;
    const stored = localStorage.getItem(AUTH_TOKENS_KEY);
    if (stored) {
      try {
        this.tokens = JSON.parse(stored);
      } catch (e) {
        console.error('Failed to parse stored tokens:', e);
      }
    }
  }

  /**
   * Save tokens to localStorage
   */
  private saveTokens(tokens: AuthTokens): void {
    if (typeof window === 'undefined') return;
    this.tokens = tokens;
    localStorage.setItem(AUTH_TOKENS_KEY, JSON.stringify(tokens));
    console.log('[DEBUG AUTH] Tokens saved to localStorage:', { access: tokens.access?.substring(0, 20) + '...', refresh: tokens.refresh?.substring(0, 20) + '...' });
  }

  /**
   * Clear tokens from localStorage
   */
  private clearTokens(): void {
    if (typeof window === 'undefined') return;
    this.tokens = null;
    localStorage.removeItem(AUTH_TOKENS_KEY);
  }

  /**
   * Load sync queue from localStorage
   */
  private loadSyncQueue(): void {
    if (typeof window === 'undefined') return;
    const stored = localStorage.getItem(SYNC_QUEUE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        this.syncQueue = Array.isArray(parsed) ? parsed : [];
        const queueChanged = this.dedupeSyncQueue();
        if (queueChanged) {
          this.saveSyncQueue();
        }
      } catch (e) {
        console.error('Failed to parse sync queue:', e);
        this.syncQueue = [];
      }
    }
  }

  /**
   * Save sync queue to localStorage
   */
  private saveSyncQueue(): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(this.syncQueue));
  }

  /**
   * Detect fetch-level failures where the request never produced an HTTP response.
   */
  private isLikelyNetworkError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const normalizedMessage = message.trim().toLowerCase();

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return true;
    }

    return (
      normalizedMessage.includes('failed to fetch') ||
      normalizedMessage.includes('networkerror') ||
      normalizedMessage.includes('network request failed') ||
      normalizedMessage.includes('load failed') ||
      normalizedMessage.includes('fetch failed') ||
      normalizedMessage.includes('timeout')
    );
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private shouldRetryTransientNetworkError(
    error: unknown,
    attempt: number,
    maxAttempts: number
  ): boolean {
    if (attempt >= maxAttempts) {
      return false;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return false;
    }

    return this.isLikelyNetworkError(error);
  }

  private async executeFetchWithRetry(
    input: string,
    init: RequestInit,
    options: {
      maxAttempts?: number;
      label?: string;
    } = {}
  ): Promise<Response> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
    const label = options.label || input;
    let attempt = 1;

    while (true) {
      try {
        return await fetch(input, init);
      } catch (error) {
        if (!this.shouldRetryTransientNetworkError(error, attempt, maxAttempts)) {
          throw error;
        }

        console.warn(`[AuthFetch] Transient network error during ${label}; retrying request (attempt ${attempt + 1}/${maxAttempts})`, error);
        await this.delay(TRANSIENT_NETWORK_RETRY_DELAY_MS * attempt);
        attempt += 1;
      }
    }
  }

  /**
   * Provide a more actionable message for desktop users when the backend cannot be reached.
   */
  private createReachabilityError(
    error: unknown,
    requestUrl: string,
    options: { queued?: boolean; offline?: boolean } = {}
  ): Error {
    let requestHost = requestUrl;
    try {
      requestHost = new URL(requestUrl).host;
    } catch {
      requestHost = requestUrl;
    }

    const userMessage = options.queued
      ? options.offline
        ? 'Offline - request queued for retry'
        : `Could not reach ${requestHost} - request queued for retry`
      : options.offline
        ? 'No internet connection.'
        : `Could not reach ${requestHost}. Your internet may still be connected, but the app could not contact the server. Check hotspot/VPN/DNS/server availability and try again.`;
    const originalMessage = error instanceof Error ? error.message : String(error ?? '');

    const wrapped = new Error(userMessage);
    (wrapped as any).isNetworkError = true;
    (wrapped as any).requestUrl = requestUrl;
    (wrapped as any).originalMessage = originalMessage;
    (wrapped as any).debugMessage = `Request URL: ${requestUrl}`;

    if (error instanceof Error && error.stack) {
      wrapped.stack = error.stack;
    }

    return wrapped;
  }

  /**
   * Parse queued body safely (body is often JSON stringified before being passed to fetch)
   */
  private parseQueueBody(body?: any): any {
    if (typeof body !== 'string') return body;
    try {
      return JSON.parse(body);
    } catch {
      // If it's not JSON (or already a plain string), keep as-is.
      return body;
    }
  }

  /**
   * Stable JSON stringify for queue dedupe signatures (object keys sorted recursively)
   */
  private stableStringify(value: any): string {
    const normalize = (input: any): any => {
      if (Array.isArray(input)) {
        return input.map(normalize);
      }
      if (input && typeof input === 'object') {
        const sortedKeys = Object.keys(input).sort();
        const normalized: Record<string, any> = {};
        for (const key of sortedKeys) {
          normalized[key] = normalize(input[key]);
        }
        return normalized;
      }
      return input;
    };

    try {
      const serialized = JSON.stringify(normalize(value));
      return serialized === undefined ? 'undefined' : serialized;
    } catch {
      return String(value);
    }
  }

  /**
   * Build a deterministic signature for queue items so retries don't duplicate entries.
   */
  private getQueueItemSignature(item: {
    method: SyncQueueItem['method'];
    url: string;
    body?: any;
    domain?: QueueDomain;
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, any>;
  }): string {
    return [
      item.method,
      item.url,
      item.domain || '',
      item.entityType || '',
      item.entityId || '',
      this.stableStringify(item.body),
      this.stableStringify(item.metadata),
    ].join('::');
  }

  /**
   * Remove duplicate queue entries while preserving the most recent payload.
   */
  private dedupeSyncQueue(): boolean {
    if (this.syncQueue.length <= 1) return false;

    const deduped: SyncQueueItem[] = [];
    const indexBySignature = new Map<string, number>();

    for (const item of this.syncQueue) {
      const signature = this.getQueueItemSignature(item);
      const existingIndex = indexBySignature.get(signature);

      if (existingIndex === undefined) {
        indexBySignature.set(signature, deduped.length);
        deduped.push(item);
        continue;
      }

      const existing = deduped[existingIndex];
      const useIncoming = (item.timestamp || 0) >= (existing.timestamp || 0);
      const preferred = useIncoming ? item : existing;
      const fallback = useIncoming ? existing : item;

      deduped[existingIndex] = {
        ...fallback,
        ...preferred,
        retries: Math.max(existing.retries || 0, item.retries || 0),
        maxRetries: Math.max(existing.maxRetries || MAX_RETRIES, item.maxRetries || MAX_RETRIES),
      };
    }

    if (deduped.length === this.syncQueue.length) {
      return false;
    }

    console.log(`[DEBUG SYNC QUEUE] Deduplicated queue from ${this.syncQueue.length} to ${deduped.length} items`);
    this.syncQueue = deduped;
    return true;
  }

  /**
   * One-time migration for legacy duplicate queue inflation.
   * Runs once per browser profile and persists deduped queue.
   */
  private runOneTimeQueueMigration(): void {
    if (typeof window === 'undefined') return;
    if (localStorage.getItem(SYNC_QUEUE_MIGRATION_KEY)) return;

    const before = this.syncQueue.length;
    const changed = this.dedupeSyncQueue();
    const after = this.syncQueue.length;

    if (changed) {
      this.saveSyncQueue();
    }

    localStorage.setItem(SYNC_QUEUE_MIGRATION_KEY, String(Date.now()));
    console.log(`[DEBUG SYNC QUEUE] Migration completed. Before=${before}, After=${after}`);
  }

  /**
   * Setup network listeners for online/offline events
   */
  private setupNetworkListeners(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', () => {
      this.isOnline = true;
      console.log('Network online - starting sync');
      this.processSyncQueue();
    });
    window.addEventListener('offline', () => {
      this.isOnline = false;
      console.log('Network offline - queuing requests');
    });
  }

  /**
   * Start periodic sync interval
   */
  private startSyncInterval(): void {
    if (typeof window === 'undefined') return;
    this.syncIntervalId = setInterval(() => {
      if (this.isOnline && this.syncQueue.length > 0) {
        this.processSyncQueue();
      }
    }, SYNC_INTERVAL);
  }

  /**
   * Stop sync interval
   */
  private stopSyncInterval(): void {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  /**
   * Refresh access token using refresh token
   */
  private async refreshAccessToken(options: { clearOnFailure?: boolean } = {}): Promise<boolean> {
    const clearOnFailure = options.clearOnFailure !== false;
    if (!this.tokens?.refresh) {
      if (clearOnFailure) {
        this.clearTokens();
      }
      return false;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/auth/token/refresh/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: this.tokens.refresh }),
      });

      if (!response.ok) {
        if (clearOnFailure) {
          this.clearTokens();
        }
        return false;
      }

      const data = await response.json();
      this.saveTokens({
        access: data.access,
        refresh: this.tokens.refresh,
      });
      return true;
    } catch (error) {
      console.error('Token refresh failed:', error);
      if (clearOnFailure) {
        this.clearTokens();
      }
      return false;
    }
  }

  /**
   * Get authorization headers
   */
  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.tokens?.access) {
      headers['Authorization'] = `Bearer ${this.tokens.access}`;
    }
    const deviceSerial = getDeviceSerial();
    if (deviceSerial) {
      headers['X-HandyPOS-Device-Serial'] = deviceSerial;
    }
    return headers;
  }

  /**
   * Queue a request for later sync
   */
  private queueRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    url: string,
    body?: any,
    meta?: { domain?: QueueDomain; entityType?: string; entityId?: string; metadata?: Record<string, any> }
  ): void {
    const parsedBody = this.parseQueueBody(body);
    const signature = this.getQueueItemSignature({
      method,
      url,
      body: parsedBody,
      domain: meta?.domain,
      entityType: meta?.entityType,
      entityId: meta?.entityId,
      metadata: meta?.metadata,
    });

    const existingIndex = this.syncQueue.findIndex(
      (queuedItem) => this.getQueueItemSignature(queuedItem) === signature
    );

    if (existingIndex !== -1) {
      const existing = this.syncQueue[existingIndex];
      this.syncQueue[existingIndex] = {
        ...existing,
        timestamp: Date.now(),
        body: parsedBody,
        error: undefined,
        domain: meta?.domain ?? existing.domain,
        entityType: meta?.entityType ?? existing.entityType,
        entityId: meta?.entityId ?? existing.entityId,
        metadata: meta?.metadata ?? existing.metadata,
      };
      this.saveSyncQueue();
      console.log('[DEBUG SYNC QUEUE] Duplicate request detected; refreshed existing queue item:', {
        method,
        url,
        queueLength: this.syncQueue.length,
      });
      return;
    }

    const item: SyncQueueItem = {
      id: `${Date.now()}-${Math.random()}`,
      method,
      url,
      body: parsedBody,
      timestamp: Date.now(),
      retries: 0,
      maxRetries: MAX_RETRIES,
      error: undefined,
      domain: meta?.domain,
      entityType: meta?.entityType,
      entityId: meta?.entityId,
      metadata: meta?.metadata,
    };
    this.syncQueue.push(item);
    this.saveSyncQueue();
    console.log('[DEBUG SYNC QUEUE] Queued request:', { method, url, domain: item.domain, entityType: item.entityType, entityId: item.entityId, queueLength: this.syncQueue.length });
  }

  /**
   * Process sync queue
   */
  private async processSyncQueue(): Promise<void> {
    if (!this.isOnline || this.syncQueue.length === 0) return;

    // Process in place, remove only when successful
    const queueSnapshot = [...this.syncQueue];

    for (const snapshotItem of queueSnapshot) {
      const idx = this.syncQueue.findIndex(q => q.id === snapshotItem.id);
      if (idx === -1) continue; // already removed
      const item = this.syncQueue[idx];

      try {
        const response = await fetch(item.url, {
          method: item.method,
          headers: this.getAuthHeaders(),
          body: item.body ? JSON.stringify(item.body) : undefined,
        });

        if (response.status === 401) {
          // Token expired, try to refresh then keep item for retry
          const refreshed = await this.refreshAccessToken({ clearOnFailure: false });
          if (!refreshed) {
            item.retries += 1;
            item.error = 'Unauthorized; token refresh failed';
          } else {
            // Token refreshed; attempt again on next cycle
            item.retries += 1;
            item.error = 'Retry after token refresh';
          }
        } else if (!response.ok) {
          let errorMessage = `HTTP ${response.status}`;
          try {
            const errorData = await response.json();
            errorMessage = this.extractErrorMessage(errorData, response.status);
          } catch {
            // Keep the generic HTTP status if the response is not JSON.
          }

          if (this.isPermanentHttpFailure(response.status)) {
            console.warn('[AuthFetch] Dropping non-retryable queued request:', {
              method: item.method,
              url: item.url,
              status: response.status,
              error: errorMessage,
            });
            this.syncQueue.splice(idx, 1);
          } else {
            item.retries += 1;
            item.error = errorMessage;
          }
        } else {
          // Success → remove from queue
          this.syncQueue.splice(idx, 1);
        }
      } catch (error: any) {
        // Network or other error; keep item and record error
        item.retries += 1;
        item.error = error?.message || 'Network error';
      }

      this.saveSyncQueue();
    }
  }

  private isPermanentHttpFailure(status: number): boolean {
    return status >= 400 && status < 500 && ![401, 408, 409, 423, 425, 429].includes(status);
  }

  private extractErrorMessage(errorData: any, status: number): string {
    let errorMessage = `HTTP ${status}`;

    if (errorData?.detail) {
      errorMessage = errorData.detail;
    } else if (errorData?.message) {
      errorMessage = errorData.message;
    } else if (errorData?.error) {
      errorMessage = Array.isArray(errorData.error) ? errorData.error[0] : String(errorData.error);
    } else if (errorData?.non_field_errors && Array.isArray(errorData.non_field_errors)) {
      errorMessage = errorData.non_field_errors[0];
    } else if (errorData && typeof errorData === 'object') {
      const firstKey = Object.keys(errorData)[0];
      if (firstKey && Array.isArray(errorData[firstKey])) {
        errorMessage = errorData[firstKey][0];
      } else if (firstKey && typeof errorData[firstKey] === 'string') {
        errorMessage = errorData[firstKey];
      }
    }

    return errorMessage;
  }

  /**
   * Main fetch method with offline-first support
   */
  async fetch<T = any>(
    url: string,
    options: RequestInit & {
      offline?: boolean;
      queueOnFailure?: boolean;
      meta?: {
        domain?: QueueDomain;
        entityType?: string;
        entityId?: string;
        metadata?: Record<string, any>;
      };
    } = {}
  ): Promise<T> {
    const { offline = false, queueOnFailure = true, meta, ...fetchOptions } = options;
    const method = (fetchOptions.method || 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    const fullUrl = url.startsWith('http') ? url : `${API_BASE_URL}${url}`;

    // Add auth headers
    fetchOptions.headers = {
      ...this.getAuthHeaders(),
      ...(fetchOptions.headers as Record<string, string>),
    };

    try {
      // Always attempt to fetch from server (Django is always accessible locally)
      const response = await this.executeFetchWithRetry(fullUrl, fetchOptions, {
        maxAttempts: method === 'GET' ? 2 : 1,
        label: `${method} ${fullUrl}`,
      });

      // Handle token expiration (but not for login/register endpoints)
      if (response.status === 401) {
        // Don't retry login/register endpoints
        if (fullUrl.includes('/accounts/login/') || fullUrl.includes('/accounts/register/')) {
          throw new Error('Invalid credentials');
        }
        
        const refreshed = await this.refreshAccessToken();
        if (refreshed) {
          // Retry the request with new token
          fetchOptions.headers = this.getAuthHeaders();
          return this.fetch<T>(url, { ...options, offline });
        } else {
          throw new Error('Unauthorized - please login again');
        }
      }

      if (!response.ok) {
        let errorData: any = {};
        try {
          errorData = await response.json();
        } catch (e) {
          // Response is not JSON
        }
        
        const errorMessage = this.extractErrorMessage(errorData, response.status);
        
        const error = new Error(errorMessage);
        (error as any).status = response.status;
        (error as any).data = errorData;
        throw error;
      }

      if (response.status === 204) {
        return null as T;
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength === '0') {
        return null as T;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('application/json')) {
        return null as T;
      }

      return await response.json();
    } catch (error: any) {
      const isOffline =
        !this.isOnline ||
        (typeof navigator !== 'undefined' && navigator.onLine === false);
      const isNetworkError = this.isLikelyNetworkError(error);

      if (isOffline && method !== 'GET') {
        if (queueOnFailure) {
          this.queueRequest(method, fullUrl, fetchOptions.body, meta);
          console.log(`Queued ${method} request to ${fullUrl} because the device is offline`);
          throw this.createReachabilityError(error, fullUrl, { queued: true, offline: true });
        }

        throw this.createReachabilityError(error, fullUrl, { offline: true });
      }

      if (isNetworkError && method !== 'GET') {
        if (queueOnFailure) {
          console.log(`[AuthFetch] Network error - queueing ${method} request to ${fullUrl} for retry`);
          this.queueRequest(method, fullUrl, fetchOptions.body, meta);
          throw this.createReachabilityError(error, fullUrl, { queued: true });
        }

        throw this.createReachabilityError(error, fullUrl);
      }

      if (isNetworkError || isOffline) {
        throw this.createReachabilityError(error, fullUrl, isOffline ? { offline: true } : {});
      }

      throw error;
    }
  }

  /**
   * Login and store tokens
   */
  async login(emailOrPhone: string, password: string): Promise<AuthTokens> {
    const fullUrl = `${API_BASE_URL}/accounts/login/`;
    
    // Determine if input is email or phone
    const isEmail = emailOrPhone.includes('@');
    const body: any = { password };
    
    if (isEmail) {
      body.email = emailOrPhone;
    } else {
      body.phone = emailOrPhone;
    }

    console.log('[DEBUG LOGIN] Sending login request to:', fullUrl);
    console.log('[DEBUG LOGIN] Body:', body);

    try {
      const response = await this.executeFetchWithRetry(fullUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        credentials: 'omit',
        body: JSON.stringify(body),
      }, {
        maxAttempts: 2,
        label: `LOGIN ${fullUrl}`,
      });

      console.log('[DEBUG LOGIN] Response status:', response.status);
      console.log('[DEBUG LOGIN] Response headers:', {
        'content-type': response.headers.get('content-type'),
        'access-control-allow-origin': response.headers.get('access-control-allow-origin'),
      });

      if (!response.ok) {
        let errorData: any = {};
        try {
          errorData = await response.json();
        } catch (e) {
          console.error('[DEBUG LOGIN] Failed to parse error response');
        }
        console.error('[DEBUG LOGIN] Login failed:', errorData);
        const errorMessage = errorData.error || errorData.detail || errorData.message || `HTTP ${response.status}`;
        throw new Error(errorMessage);
      }

      const data = await response.json();
      console.log('[DEBUG LOGIN] Login successful, received data:', { access: data.access?.substring(0, 20) + '...', refresh: data.refresh?.substring(0, 20) + '...' });
      
      // Verify tokens exist
      if (!data.access || !data.refresh) {
        throw new Error('Invalid response: missing tokens');
      }
      
      this.saveTokens({
        access: data.access,
        refresh: data.refresh,
      });
      return data;
    } catch (error) {
      console.error('[DEBUG LOGIN] Login error:', error);
      if (this.isLikelyNetworkError(error)) {
        throw this.createReachabilityError(error, fullUrl);
      }
      throw error;
    }
  }

  /**
   * Register and store tokens
   */
  async register(
    emailOrPhone: string,
    password: string,
    firstName?: string,
    lastName?: string
  ): Promise<AuthTokens & { user?: any }> {
    const fullUrl = `${API_BASE_URL}/accounts/register/`;
    
    // Determine if input is email or phone
    const isEmail = emailOrPhone.includes('@');
    const body: any = {
      password,
      first_name: firstName,
      last_name: lastName,
    };
    
    if (isEmail) {
      body.email = emailOrPhone;
    } else {
      body.phone = emailOrPhone;
    }

    console.log('[DEBUG REGISTER] Sending registration request:', { url: fullUrl, body });

    const response = await fetch(fullUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      credentials: 'omit',
      body: JSON.stringify(body),
    });

    console.log('[DEBUG REGISTER] Response status:', response.status);

    if (!response.ok) {
      let errorData: any = {};
      try {
        errorData = await response.json();
      } catch (e) {
        console.error('[DEBUG REGISTER] Failed to parse error response');
      }
      console.error('[DEBUG REGISTER] Registration failed:', errorData);
      const errorMessage = errorData.detail || errorData.message || errorData.error || JSON.stringify(errorData) || `HTTP ${response.status}`;
      throw new Error(errorMessage);
    }

    const data = await response.json();
    console.log('[DEBUG REGISTER] Register response:', data);
    
    // Extract tokens from response
    const tokens: AuthTokens = {
      access: data.access,
      refresh: data.refresh,
    };
    
    if (!tokens.access || !tokens.refresh) {
      console.error('[DEBUG REGISTER] Missing tokens in response:', data);
      throw new Error('Invalid response: missing tokens');
    }
    
    console.log('[DEBUG REGISTER] Extracted tokens:', { access: tokens.access?.substring(0, 20) + '...', refresh: tokens.refresh?.substring(0, 20) + '...' });
    
    this.syncQueue = [];
    this.saveSyncQueue();
    this.saveTokens(tokens);
    console.log('[DEBUG REGISTER] Tokens saved to localStorage');
    
    return { ...tokens, user: data.user };
  }

  /**
   * Logout and clear tokens
   */
  logout(): void {
    this.clearTokens();
    this.stopSyncInterval();
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return !!this.tokens?.access;
  }

  /**
   * Get current tokens
   */
  getTokens(): AuthTokens | null {
    return this.tokens;
  }

  /**
   * Get sync queue status
   */
  getSyncQueueStatus(): { count: number; items: SyncQueueItem[] } {
    const queueChanged = this.dedupeSyncQueue();
    if (queueChanged) {
      this.saveSyncQueue();
    }

    return {
      count: this.syncQueue.length,
      items: this.syncQueue,
    };
  }

  /**
   * Get online status
   */
  getOnlineStatus(): boolean {
    return this.isOnline;
  }
}

// Export singleton instance
export const authFetch = new AuthenticatedFetch();
