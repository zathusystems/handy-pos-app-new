'use client';

import { useEffect, useMemo, useRef } from 'react';

type AudioWindow = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

let audioContext: AudioContext | null = null;
let orderNotificationAudio: HTMLAudioElement | null = null;
let notificationAudioUnlocked = false;
let lastNotificationAt = 0;

const ORDER_NOTIFICATION_SOUND_SRC = '/sounds/order-bell.mp3';
const ORDER_NOTIFICATION_COOLDOWN_MS = 900;

const getAudioContext = (): AudioContext | null => {
  if (typeof window === 'undefined') return null;

  const audioWindow = window as AudioWindow;
  const AudioContextConstructor = window.AudioContext || audioWindow.webkitAudioContext;
  if (!AudioContextConstructor) return null;

  if (!audioContext) {
    audioContext = new AudioContextConstructor();
  }

  return audioContext;
};

const getOrderNotificationAudio = (): HTMLAudioElement | null => {
  if (typeof window === 'undefined') return null;

  if (!orderNotificationAudio) {
    orderNotificationAudio = new Audio(ORDER_NOTIFICATION_SOUND_SRC);
    orderNotificationAudio.preload = 'auto';
    orderNotificationAudio.volume = 1;
  }

  return orderNotificationAudio;
};

export const unlockOrderNotificationSound = async () => {
  const context = getAudioContext();
  if (context?.state === 'suspended') {
    try {
      await context.resume();
    } catch (error) {
      console.warn('[OrderSound] Unable to unlock audio context:', error);
    }
  }

  if (notificationAudioUnlocked) return;

  const audio = getOrderNotificationAudio();
  if (!audio) return;

  try {
    audio.muted = true;
    await audio.play();
    audio.pause();
    audio.currentTime = 0;
    audio.muted = false;
    notificationAudioUnlocked = true;
  } catch (error) {
    audio.muted = false;
    console.warn('[OrderSound] Unable to unlock notification audio:', error);
  }
};

const playFallbackOrderNotificationSound = async () => {
  const context = getAudioContext();
  if (!context) return;

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }

    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.52);
    gain.connect(context.destination);

    [880, 1174].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, now + index * 0.16);
      oscillator.connect(gain);
      oscillator.start(now + index * 0.16);
      oscillator.stop(now + index * 0.16 + 0.22);
    });

    window.setTimeout(() => gain.disconnect(), 700);
  } catch (error) {
    console.warn('[OrderSound] Unable to play notification sound:', error);
  }
};

export const playOrderNotificationSound = async () => {
  const now = Date.now();
  if (now - lastNotificationAt < ORDER_NOTIFICATION_COOLDOWN_MS) return;

  lastNotificationAt = now;

  const audio = getOrderNotificationAudio();
  if (audio) {
    try {
      audio.pause();
      audio.currentTime = 0;
      audio.muted = false;
      audio.volume = 1;
      await audio.play();
      return;
    } catch (error) {
      console.warn('[OrderSound] Unable to play bell audio; using fallback:', error);
    }
  }

  await playFallbackOrderNotificationSound();
};

export const useOrderNotificationSound = (
  orderIds: Array<string | number | null | undefined>,
  enabled = true
) => {
  const previousIdsRef = useRef<Set<string> | null>(null);
  const orderSignature = useMemo(
    () => orderIds
      .map((id) => String(id ?? '').trim())
      .filter(Boolean)
      .sort()
      .join('|'),
    [orderIds]
  );

  useEffect(() => {
    if (!enabled) {
      previousIdsRef.current = null;
      return;
    }

    const nextIds = new Set(orderSignature ? orderSignature.split('|') : []);
    const previousIds = previousIdsRef.current;
    previousIdsRef.current = nextIds;

    if (!previousIds || nextIds.size === 0) return;

    const hasNewOrder = Array.from(nextIds).some((id) => !previousIds.has(id));
    if (hasNewOrder) {
      void playOrderNotificationSound();
    }
  }, [enabled, orderSignature]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const unlock = () => {
      void unlockOrderNotificationSound();
    };

    window.addEventListener('pointerdown', unlock, { once: true, passive: true });
    window.addEventListener('keydown', unlock, { once: true });

    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [enabled]);
};
