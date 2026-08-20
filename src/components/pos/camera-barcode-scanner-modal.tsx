'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Camera, Flashlight, FlashlightOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { normalizeBarcodeValue } from '@/lib/barcode';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type DetectorResult = {
  rawValue?: string | null;
};

type DetectorInstance = {
  detect: (source: ImageBitmapSource) => Promise<DetectorResult[]>;
};

type DetectorConstructor = {
  new (options?: { formats?: string[] }): DetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
};

export type BarcodeDetectionOutcome = {
  accepted: boolean;
  productName?: string;
  message?: string;
};

type ScanHistoryEntry = {
  barcode: string;
  productName: string;
  count: number;
  lastScannedAt: string;
};

interface CameraBarcodeScannerModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onBarcodeDetected: (barcode: string) => Promise<BarcodeDetectionOutcome | boolean> | BarcodeDetectionOutcome | boolean;
  closeOnSuccessfulDetection?: boolean;
}

const PREFERRED_FORMATS = [
  'code_128',
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
];
const SAME_BARCODE_COOLDOWN_MS = 1200;
const REQUIRED_STABLE_DETECTIONS = 3;
const SCAN_REGION_WIDTH_RATIO = 0.78;
const SCAN_REGION_HEIGHT_RATIO = 0.42;
const TRANSIENT_SCAN_MESSAGE_DURATION_MS = 800;
const STANDARD_BARCODE_LENGTHS = new Set([8, 12, 13, 14]);

function normalizeDetectionOutcome(result: BarcodeDetectionOutcome | boolean): BarcodeDetectionOutcome {
  if (typeof result === 'boolean') {
    return { accepted: result };
  }
  return {
    accepted: Boolean(result.accepted),
    productName: result.productName,
    message: result.message,
  };
}

function getCameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      return 'Camera permission was denied. Allow camera access and try again.';
    }
    if (error.name === 'NotFoundError') {
      return 'No camera was found on this device.';
    }
    if (error.name === 'NotReadableError') {
      return 'Camera is already in use by another app.';
    }
    if (error.name === 'OverconstrainedError') {
      return 'Unable to start the camera with the selected settings.';
    }
  }

  return error instanceof Error
    ? error.message
    : 'Unable to start camera scanner. Please try again.';
}

export function CameraBarcodeScannerModal({
  isOpen,
  onOpenChange,
  onBarcodeDetected,
  closeOnSuccessfulDetection = false,
}: CameraBarcodeScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const uprightScanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rotatedScanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<DetectorInstance | null>(null);
  const scanFrameRef = useRef<number | null>(null);
  const scanLockRef = useRef(false);
  const handlingBarcodeRef = useRef(false);
  const lastScanTsRef = useRef(0);
  const lastAcceptedBarcodeRef = useRef('');
  const lastAcceptedAtRef = useRef(0);
  const pendingBarcodeRef = useRef('');
  const pendingBarcodeDetectionsRef = useRef(0);
  const transientMessageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [lastDetectedBarcode, setLastDetectedBarcode] = useState('');
  const [scanHistory, setScanHistory] = useState<ScanHistoryEntry[]>([]);
  const [status, setStatus] = useState<'starting' | 'scanning' | 'fallback' | 'error'>('starting');
  const [errorMessage, setErrorMessage] = useState('');
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [isTorchUpdating, setIsTorchUpdating] = useState(false);

  const handleCloseScanner = useCallback(
    (event?: React.SyntheticEvent) => {
      event?.preventDefault();
      event?.stopPropagation();
      onOpenChange(false);
    },
    [onOpenChange]
  );

  const stopScanner = useCallback(() => {
    if (scanFrameRef.current !== null) {
      cancelAnimationFrame(scanFrameRef.current);
      scanFrameRef.current = null;
    }

    detectorRef.current = null;
    scanLockRef.current = false;
    lastScanTsRef.current = 0;
    lastAcceptedBarcodeRef.current = '';
    lastAcceptedAtRef.current = 0;
    pendingBarcodeRef.current = '';
    pendingBarcodeDetectionsRef.current = 0;
    if (transientMessageTimeoutRef.current) {
      clearTimeout(transientMessageTimeoutRef.current);
      transientMessageTimeoutRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setTorchAvailable(false);
    setTorchEnabled(false);
    setIsTorchUpdating(false);
  }, []);

  const getScanCanvas = useCallback((
    video: HTMLVideoElement,
    orientation: 'upright' | 'rotated'
  ): HTMLCanvasElement | null => {
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;

    if (!sourceWidth || !sourceHeight) {
      return null;
    }

    const scanWidth = Math.max(1, Math.floor(sourceWidth * SCAN_REGION_WIDTH_RATIO));
    const scanHeight = Math.max(1, Math.floor(sourceHeight * SCAN_REGION_HEIGHT_RATIO));
    const offsetX = Math.max(0, Math.floor((sourceWidth - scanWidth) / 2));
    const offsetY = Math.max(0, Math.floor((sourceHeight - scanHeight) / 2));

    const canvasRef = orientation === 'rotated' ? rotatedScanCanvasRef : uprightScanCanvasRef;

    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
    }

    const canvas = canvasRef.current;
    canvas.width = scanWidth;
    canvas.height = scanHeight;

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return null;
    }

    context.save();
    context.clearRect(0, 0, scanWidth, scanHeight);
    if (orientation === 'rotated') {
      context.translate(scanWidth, scanHeight);
      context.rotate(Math.PI);
    }
    context.drawImage(
      video,
      offsetX,
      offsetY,
      scanWidth,
      scanHeight,
      0,
      0,
      scanWidth,
      scanHeight
    );
    context.restore();

    return canvas;
  }, []);

  const setTransientErrorMessage = useCallback((message: string) => {
    if (transientMessageTimeoutRef.current) {
      clearTimeout(transientMessageTimeoutRef.current);
      transientMessageTimeoutRef.current = null;
    }

    setErrorMessage(message);
    transientMessageTimeoutRef.current = setTimeout(() => {
      setErrorMessage((currentMessage) => currentMessage === message ? '' : currentMessage);
      transientMessageTimeoutRef.current = null;
    }, TRANSIENT_SCAN_MESSAGE_DURATION_MS);
  }, []);

  const detectBarcodeCandidates = useCallback(async (
    detector: DetectorInstance,
    video: HTMLVideoElement
  ): Promise<string[]> => {
    const rankCandidates = (values: string[]): string[] => {
      const uniqueValues = Array.from(new Set(values));

      return uniqueValues.sort((left, right) => {
        const leftLengthPriority = STANDARD_BARCODE_LENGTHS.has(left.length)
          ? 2
          : left.length >= 8
            ? 1
            : 0;
        const rightLengthPriority = STANDARD_BARCODE_LENGTHS.has(right.length)
          ? 2
          : right.length >= 8
            ? 1
            : 0;

        return (
          rightLengthPriority - leftLengthPriority ||
          right.length - left.length ||
          left.localeCompare(right)
        );
      });
    };

    const extractDetectedValues = async (source: ImageBitmapSource): Promise<string[]> => {
      const results = await detector.detect(source);
      return rankCandidates(
        results
          .map((entry) => normalizeBarcodeValue(entry.rawValue))
          .filter((value) => value.length > 0)
      );
    };

    const uprightCanvas = getScanCanvas(video, 'upright');
    if (uprightCanvas) {
      const uprightValues = await extractDetectedValues(uprightCanvas as ImageBitmapSource);
      if (uprightValues.length > 0) {
        return uprightValues;
      }
    }

    const rotatedCanvas = getScanCanvas(video, 'rotated');
    if (rotatedCanvas) {
      const rotatedValues = await extractDetectedValues(rotatedCanvas as ImageBitmapSource);
      if (rotatedValues.length > 0) {
        return rotatedValues;
      }
    }

    return extractDetectedValues(video as unknown as ImageBitmapSource);
  }, [getScanCanvas]);

  const triggerVibrationFeedback = useCallback(() => {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate([40, 20, 60]);
    }
  }, []);

  const addToScanHistory = useCallback((barcode: string, productName?: string) => {
    const trimmedBarcode = barcode.trim();
    if (!trimmedBarcode) {
      return;
    }

    const nowIso = new Date().toISOString();
    const fallbackName = `Barcode ${trimmedBarcode}`;

    setScanHistory((previous) => {
      const existingIndex = previous.findIndex((entry) => entry.barcode === trimmedBarcode);
      if (existingIndex >= 0) {
        const next = [...previous];
        const existing = next[existingIndex];
        next[existingIndex] = {
          ...existing,
          productName: productName?.trim() || existing.productName || fallbackName,
          count: existing.count + 1,
          lastScannedAt: nowIso,
        };
        return next.sort((a, b) => b.lastScannedAt.localeCompare(a.lastScannedAt));
      }

      return [
        {
          barcode: trimmedBarcode,
          productName: productName?.trim() || fallbackName,
          count: 1,
          lastScannedAt: nowIso,
        },
        ...previous,
      ].slice(0, 20);
    });
  }, []);

  const applyTorchConstraint = useCallback(async (enabled: boolean): Promise<boolean> => {
    if (!streamRef.current) {
      return false;
    }

    const [videoTrack] = streamRef.current.getVideoTracks();
    if (!videoTrack || typeof videoTrack.applyConstraints !== 'function') {
      return false;
    }

    try {
      await videoTrack.applyConstraints({
        advanced: [{ torch: enabled } as MediaTrackConstraintSet],
      });
      setTorchEnabled(enabled);
      return true;
    } catch {
      try {
        await videoTrack.applyConstraints({ torch: enabled } as MediaTrackConstraints);
        setTorchEnabled(enabled);
        return true;
      } catch (error) {
        console.warn('[Camera Scanner] Failed to update torch state:', error);
        return false;
      }
    }
  }, []);

  const createDetector = useCallback(async (): Promise<DetectorInstance | null> => {
    const detectorCtor = (window as Window & { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
    if (!detectorCtor) {
      return null;
    }

    try {
      const getFormats = detectorCtor.getSupportedFormats;
      if (typeof getFormats !== 'function') {
        return new detectorCtor();
      }

      const supportedFormats = await getFormats();
      const selectedFormats = PREFERRED_FORMATS.filter((format) => supportedFormats.includes(format));
      if (selectedFormats.length > 0) {
        return new detectorCtor({ formats: selectedFormats });
      }

      return new detectorCtor();
    } catch (error) {
      console.warn('[Camera Scanner] Failed to initialize BarcodeDetector:', error);
      return null;
    }
  }, []);

  const handleBarcode = useCallback(async (barcode: string): Promise<BarcodeDetectionOutcome> => {
    const trimmed = normalizeBarcodeValue(barcode);
    if (!trimmed || handlingBarcodeRef.current) {
      return { accepted: false };
    }

    const now = Date.now();
    if (
      trimmed === lastAcceptedBarcodeRef.current
      && now - lastAcceptedAtRef.current < SAME_BARCODE_COOLDOWN_MS
    ) {
      return { accepted: false };
    }

    handlingBarcodeRef.current = true;
    try {
      const result = await Promise.resolve(onBarcodeDetected(trimmed));
      const outcome = normalizeDetectionOutcome(result);

      if (outcome.accepted) {
        setLastDetectedBarcode(trimmed);
        lastAcceptedBarcodeRef.current = trimmed;
        lastAcceptedAtRef.current = now;
        addToScanHistory(trimmed, outcome.productName);
        triggerVibrationFeedback();
        setErrorMessage('');
        if (closeOnSuccessfulDetection) {
          onOpenChange(false);
        }
      } else if (outcome.message) {
        setTransientErrorMessage(outcome.message);
      }

      return outcome;
    } finally {
      handlingBarcodeRef.current = false;
    }
  }, [addToScanHistory, closeOnSuccessfulDetection, onBarcodeDetected, onOpenChange, setTransientErrorMessage, triggerVibrationFeedback]);

  useEffect(() => {
    if (!isOpen) {
      setLastDetectedBarcode('');
      setScanHistory([]);
      setErrorMessage('');
      stopScanner();
      return;
    }

    let active = true;
    setStatus('starting');
    setErrorMessage('');

    const scanLoop = async () => {
      if (!active || !detectorRef.current || !videoRef.current) {
        return;
      }

      if (scanLockRef.current) {
        scanFrameRef.current = requestAnimationFrame(() => void scanLoop());
        return;
      }

      const video = videoRef.current;
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        scanFrameRef.current = requestAnimationFrame(() => void scanLoop());
        return;
      }

      const now = performance.now();
      if (now - lastScanTsRef.current < 120) {
        scanFrameRef.current = requestAnimationFrame(() => void scanLoop());
        return;
      }

      lastScanTsRef.current = now;
      scanLockRef.current = true;

      try {
        const detectedCandidates = await detectBarcodeCandidates(detectorRef.current, video);
        const detectedValue = detectedCandidates[0];

        if (detectedValue) {
          if (detectedValue === pendingBarcodeRef.current) {
            pendingBarcodeDetectionsRef.current += 1;
          } else {
            pendingBarcodeRef.current = detectedValue;
            pendingBarcodeDetectionsRef.current = 1;
          }

          if (pendingBarcodeDetectionsRef.current >= REQUIRED_STABLE_DETECTIONS) {
            pendingBarcodeRef.current = '';
            pendingBarcodeDetectionsRef.current = 0;
            await handleBarcode(detectedValue);
          }
        } else {
          pendingBarcodeRef.current = '';
          pendingBarcodeDetectionsRef.current = 0;
        }
      } catch (error) {
        console.debug('[Camera Scanner] Frame decode failed:', error);
      } finally {
        scanLockRef.current = false;
      }

      if (active) {
        scanFrameRef.current = requestAnimationFrame(() => void scanLoop());
      }
    };

    const startScanner = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('error');
        setErrorMessage('Camera access is not supported on this device.');
        return;
      }

      const detector = await createDetector();
      if (!active) return;

      detectorRef.current = detector;

      if (!detector) {
        setStatus('fallback');
        setErrorMessage('Automatic barcode scanning is unavailable on this device.');
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute('playsinline', 'true');
          await videoRef.current.play().catch(() => undefined);
        }

        const [videoTrack] = stream.getVideoTracks();
        if (videoTrack && typeof videoTrack.getCapabilities === 'function') {
          const capabilities = videoTrack.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
          setTorchAvailable(Boolean(capabilities?.torch));
        } else {
          setTorchAvailable(false);
        }

        if (detector) {
          setStatus('scanning');
          scanFrameRef.current = requestAnimationFrame(() => void scanLoop());
        }
      } catch (error) {
        setStatus('error');
        setErrorMessage(getCameraErrorMessage(error));
      }
    };

    void startScanner();

    return () => {
      active = false;
      stopScanner();
    };
  }, [createDetector, detectBarcodeCandidates, handleBarcode, isOpen, stopScanner]);

  const handleTorchToggle = useCallback(async () => {
    if (!torchAvailable || isTorchUpdating) {
      return;
    }

    setIsTorchUpdating(true);
    const success = await applyTorchConstraint(!torchEnabled);
    if (!success) {
      setErrorMessage('Unable to toggle flashlight on this camera.');
    } else if (errorMessage === 'Unable to toggle flashlight on this camera.') {
      setErrorMessage('');
    }
    setIsTorchUpdating(false);
  }, [applyTorchConstraint, errorMessage, isTorchUpdating, torchAvailable, torchEnabled]);

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenChange(false);
        }}
      >
        {torchAvailable && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-4 top-4 z-10 h-9 w-9 shrink-0"
            onClick={() => void handleTorchToggle()}
            disabled={isTorchUpdating}
            aria-label={torchEnabled ? 'Turn flashlight off' : 'Turn flashlight on'}
            title={torchEnabled ? 'Turn Flashlight Off' : 'Turn Flashlight On'}
          >
            {isTorchUpdating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : torchEnabled ? (
              <FlashlightOff className="h-4 w-4" />
            ) : (
              <Flashlight className="h-4 w-4" />
            )}
          </Button>
        )}
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-ml-2 h-8 w-8 shrink-0"
              onClick={handleCloseScanner}
              aria-label="Back to POS"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Camera className="h-5 w-5 shrink-0" />
            <span>Scan Barcode</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="relative overflow-hidden rounded-lg border bg-black">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="h-80 w-full object-cover sm:h-[28rem]"
            />
            {status === 'scanning' && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div
                  className="rounded-2xl border-2 border-white/90 bg-white/5 shadow-[0_0_0_9999px_rgba(0,0,0,0.2)]"
                  style={{
                    width: `${SCAN_REGION_WIDTH_RATIO * 100}%`,
                    height: `${SCAN_REGION_HEIGHT_RATIO * 100}%`,
                  }}
                />
              </div>
            )}
            {status === 'starting' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-white">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Starting camera...
              </div>
            )}
          </div>

          {errorMessage && (
            <p className={`text-sm ${status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
              {errorMessage}
            </p>
          )}

          {lastDetectedBarcode && (
            <div className="rounded-md border bg-muted/40 p-2">
              <p className="text-xs text-muted-foreground">Last detected barcode</p>
              <p className="font-mono text-sm">{lastDetectedBarcode}</p>
            </div>
          )}

          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-xs font-medium text-muted-foreground">
              Scanned Products ({scanHistory.reduce((total, entry) => total + entry.count, 0)})
            </p>
            {scanHistory.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                No products scanned yet.
              </p>
            ) : (
              <div className="mt-2 max-h-40 space-y-2 overflow-y-auto pr-1">
                {scanHistory.map((entry) => (
                  <div key={entry.barcode} className="flex items-start justify-between gap-3 rounded border bg-background p-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{entry.productName}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">{entry.barcode}</p>
                    </div>
                    <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                      x{entry.count}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
