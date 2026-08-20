/**
 * Tauri Initialization
 * Ensures Tauri API is available before using it
 */

export async function waitForTauriAPI(maxWaitTime: number = 5000): Promise<boolean> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitTime) {
    if (typeof (window as any).__TAURI__ !== 'undefined') {
      console.log('[Tauri Init] Tauri API is available');
      return true;
    }
    
    // Wait 100ms before checking again
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.warn('[Tauri Init] Tauri API not available after', maxWaitTime, 'ms');
  return false;
}

export function isTauriApp(): boolean {
  try {
    const windowRef = window as any;
    const hasTauri =
      typeof windowRef.__TAURI__ !== 'undefined' ||
      typeof windowRef.__TAURI_INTERNALS__ !== 'undefined' ||
      typeof windowRef.__TAURI_IPC__ === 'function';
    const userAgent = navigator.userAgent.toLowerCase();
    const isTauriWebview = userAgent.includes('tauri') || userAgent.includes('wry');
    
    return hasTauri || isTauriWebview;
  } catch {
    return false;
  }
}

export async function getTauriInvoke(): Promise<any> {
  // Wait for Tauri API to be available
  const isAvailable = await waitForTauriAPI();
  
  if (!isAvailable) {
    throw new Error('Tauri API is not available');
  }
  
  return (window as any).__TAURI__.invoke;
}
