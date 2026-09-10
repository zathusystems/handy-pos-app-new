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

export type OrderNotificationCandidate = {
  id: string | number | null | undefined;
  /**
   * The attention queue the order currently belongs to. A change in this
   * value is treated as an actionable status change for an existing order.
   */
  channel: string | null | undefined;
};

type OrderNotificationSoundOptions = {
  enabled?: boolean;
  /**
   * Keep sound muted until the caller has finished its first order load.
   * This prevents existing orders from sounding like new arrivals.
   */
  ready?: boolean;
};

type OrderNotificationInput = OrderNotificationCandidate | string | number | null | undefined;

export const useOrderNotificationSound = (
  candidates: OrderNotificationInput[],
  options: OrderNotificationSoundOptions | boolean = {}
) => {
  const { enabled = true, ready = true } = typeof options === 'boolean'
    ? { enabled: options }
    : options;
  const previousCandidatesRef = useRef<Map<string, string> | null>(null);
  const notificationSignature = useMemo(
    () => candidates
      .map((candidate) => {
        if (candidate && typeof candidate === 'object') {
          return {
            id: String(candidate.id ?? '').trim(),
            channel: String(candidate.channel ?? '').trim(),
          };
        }

        return {
          id: String(candidate ?? '').trim(),
          channel: 'attention',
        };
      })
      .filter((candidate) => candidate.id && candidate.channel)
      .sort((left, right) => (
        left.id === right.id
          ? left.channel.localeCompare(right.channel)
          : left.id.localeCompare(right.id)
      ))
      .map((candidate) => `${candidate.id}:${candidate.channel}`)
      .join('|'),
    [candidates]
  );

  useEffect(() => {
    if (!enabled || !ready) {
      previousCandidatesRef.current = null;
      return;
    }

    const nextCandidates = new Map<string, string>();
    if (notificationSignature) {
      notificationSignature.split('|').forEach((entry) => {
        const separatorIndex = entry.indexOf(':');
        if (separatorIndex <= 0) return;
        nextCandidates.set(entry.slice(0, separatorIndex), entry.slice(separatorIndex + 1));
      });
    }

    const previousCandidates = previousCandidatesRef.current;
    previousCandidatesRef.current = nextCandidates;

    if (!previousCandidates || nextCandidates.size === 0) return;

    const needsAttention = Array.from(nextCandidates.entries()).some(([id, channel]) => (
      !previousCandidates.has(id) || previousCandidates.get(id) !== channel
    ));
    if (needsAttention) {
      void playOrderNotificationSound();
    }
  }, [enabled, notificationSignature, ready]);

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
