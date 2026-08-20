'use client';

import { useState, useEffect } from 'react';

const LOCAL_STORAGE_KEYS = {
  ACTIVE_BRANCH: 'handypos-active-branch'
};

/**
 * Custom hook to manage active branch state and listen for branch changes
 * Use this hook in all pages that need to respond to branch changes
 * 
 * @returns {string | null} The current active branch ID
 * 
 * @example
 * const activeBranchId = useActiveBranch();
 * 
 * useEffect(() => {
 *   if (activeBranchId) {
 *     // Fetch data for this branch
 *     fetchDataForBranch(activeBranchId);
 *   }
 * }, [activeBranchId]);
 */
export function useActiveBranch(): string | null {
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);

  useEffect(() => {
    // Get initial branch from localStorage
    const branchId = localStorage.getItem(LOCAL_STORAGE_KEYS.ACTIVE_BRANCH);
    if (branchId) {
      setActiveBranchId(branchId);
    }
  }, []);

  useEffect(() => {
    // Listen for branch changes from other components
    const handleBranchChange = (e: Event) => {
      const customEvent = e as CustomEvent;
      const branchId = customEvent.detail?.branchId;
      if (branchId) {
        setActiveBranchId(branchId);
        console.log('[useActiveBranch] Branch changed to:', branchId);
      }
    };

    window.addEventListener('branchChanged', handleBranchChange);
    return () => window.removeEventListener('branchChanged', handleBranchChange);
  }, []);

  return activeBranchId;
}
