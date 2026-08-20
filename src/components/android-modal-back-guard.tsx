'use client';

import { useEffect } from 'react';
import { isTauriApp } from '@/lib/tauri-init';

const MODAL_GUARD_STATE_KEY = '__handyposModalGuard';
const GUARD_DEPTH_KEY = '__handyposModalGuardDepth';
const SUPPRESSED_POP_KEY = '__handyposSuppressedPopCount';

type WindowWithModalBackState = Window & {
  [GUARD_DEPTH_KEY]?: number;
  [SUPPRESSED_POP_KEY]?: number;
};

const DIALOG_SELECTOR = '[role="dialog"][data-state="open"]';
const BACK_GUARD_IGNORE_SELECTOR = '[data-modal-back-guard-ignore="true"], [data-sidebar="sidebar"]';

function isAndroidTauriEnvironment(): boolean {
  if (!isTauriApp()) {
    return false;
  }

  return /android/i.test(navigator.userAgent || '');
}

function getOpenDialogCount(): number {
  return Array.from(document.querySelectorAll<HTMLElement>(DIALOG_SELECTOR)).filter(
    (dialog) => !dialog.matches(BACK_GUARD_IGNORE_SELECTOR)
  ).length;
}

function dispatchEscapeToCloseTopModal(): void {
  const escapeEvent = new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    which: 27,
    bubbles: true,
    cancelable: true,
  });

  document.dispatchEvent(escapeEvent);
}

function getPersistedGuardDepth(): number {
  const win = window as WindowWithModalBackState;
  return Math.max(0, Number(win[GUARD_DEPTH_KEY] || 0));
}

function setPersistedGuardDepth(value: number): void {
  const win = window as WindowWithModalBackState;
  win[GUARD_DEPTH_KEY] = Math.max(0, value);
}

function getSuppressedPopCount(): number {
  const win = window as WindowWithModalBackState;
  return Math.max(0, Number(win[SUPPRESSED_POP_KEY] || 0));
}

function setSuppressedPopCount(value: number): void {
  const win = window as WindowWithModalBackState;
  win[SUPPRESSED_POP_KEY] = Math.max(0, value);
}

function pushModalGuardEntry(): void {
  const currentState =
    history.state && typeof history.state === 'object' ? history.state : {};
  const marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  history.pushState(
    {
      ...currentState,
      [MODAL_GUARD_STATE_KEY]: marker,
    },
    '',
    window.location.href
  );
}

function syncHistoryGuardsToDialogState(): void {
  const openDialogs = getOpenDialogCount();
  let guardDepth = getPersistedGuardDepth();

  if (openDialogs > guardDepth) {
    const toAdd = openDialogs - guardDepth;
    for (let i = 0; i < toAdd; i += 1) {
      pushModalGuardEntry();
      guardDepth += 1;
    }
    setPersistedGuardDepth(guardDepth);
    return;
  }

  if (openDialogs < guardDepth) {
    const toRemove = guardDepth - openDialogs;
    setSuppressedPopCount(getSuppressedPopCount() + toRemove);
    setPersistedGuardDepth(openDialogs);
    for (let i = 0; i < toRemove; i += 1) {
      history.back();
    }
  }
}

export function AndroidModalBackGuard() {
  useEffect(() => {
    if (!isAndroidTauriEnvironment()) {
      return;
    }

    syncHistoryGuardsToDialogState();

    const observer = new MutationObserver(() => {
      syncHistoryGuardsToDialogState();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'role'],
    });

    const onPopState = () => {
      const suppressedPops = getSuppressedPopCount();
      if (suppressedPops > 0) {
        setSuppressedPopCount(suppressedPops - 1);
        return;
      }

      const openDialogs = getOpenDialogCount();
      const guardDepth = getPersistedGuardDepth();
      if (openDialogs > 0 && guardDepth > 0) {
        setPersistedGuardDepth(guardDepth - 1);
        dispatchEscapeToCloseTopModal();
      }
    };

    window.addEventListener('popstate', onPopState);

    return () => {
      observer.disconnect();
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  return null;
}
