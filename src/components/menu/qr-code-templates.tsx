'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Download, Eye, FileImage, FileText, Loader2, QrCode as QrCodeIcon } from 'lucide-react';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';

import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

type QRTemplateStyle = 'fresh' | 'signal' | 'premium' | 'night';

interface QRTemplate {
  id: string;
  name: string;
  description: string;
  style: QRTemplateStyle;
  features: string[];
  callout: string;
  action: string;
}

type PosterTheme = {
  background: string;
  foreground: string;
  muted: string;
  panel: string;
  panelBorder: string;
  qrFrame: string;
  accent: string;
  accent2: string;
  accent3: string;
  badgeBackground: string;
  badgeForeground: string;
  footerBackground: string;
  texture: string;
};

type PosterTypography = {
  headingFont: string;
  headingSize: number;
  headingWeight: number;
  headingLineHeight: number;
  labelFont: string;
  labelSize: number;
  labelWeight: number;
  labelColor: string;
  labelTransform?: 'uppercase';
};

const POSTER_WIDTH = 480;
const POSTER_HEIGHT = 680;
const QR_SIZE = 268;

const qrTemplates: QRTemplate[] = [
  {
    id: 'fresh-table',
    name: 'Fresh Table',
    description: 'Bright, clean table-card design for restaurants and cafes.',
    style: 'fresh',
    features: ['Table card', 'Bright', 'Restaurant-ready'],
    callout: 'Order at your table',
    action: 'Scan for menu',
  },
  {
    id: 'signal',
    name: 'Signal Card',
    description: 'Modern high-contrast layout built for quick scanning.',
    style: 'signal',
    features: ['High contrast', 'Fast scan', 'Modern'],
    callout: 'Menu in seconds',
    action: 'Scan to browse',
  },
  {
    id: 'premium',
    name: 'Premium Minimal',
    description: 'Polished monochrome design for upscale dining rooms.',
    style: 'premium',
    features: ['Minimal', 'Elegant', 'Print-friendly'],
    callout: 'Digital menu',
    action: 'Scan to view',
  },
  {
    id: 'night-service',
    name: 'Night Service',
    description: 'Bold evening design for bars, lounges, and late service.',
    style: 'night',
    features: ['Bold', 'Evening', 'Bar-friendly'],
    callout: 'Drinks and food',
    action: 'Scan the code',
  },
];

const posterThemes: Record<QRTemplateStyle, PosterTheme> = {
  fresh: {
    background: '#f8faf4',
    foreground: '#17352b',
    muted: '#5f746a',
    panel: '#ffffff',
    panelBorder: '#dfe9db',
    qrFrame: '#ffffff',
    accent: '#0f8f69',
    accent2: '#f0603c',
    accent3: '#f7c948',
    badgeBackground: '#dff5e8',
    badgeForeground: '#126246',
    footerBackground: '#edf5e9',
    texture: 'rgba(15,143,105,0.12)',
  },
  signal: {
    background: '#f6f3ed',
    foreground: '#171717',
    muted: '#6c6257',
    panel: '#fffdf8',
    panelBorder: '#e5ded1',
    qrFrame: '#ffffff',
    accent: '#111827',
    accent2: '#eab308',
    accent3: '#ffffff',
    badgeBackground: '#111827',
    badgeForeground: '#ffffff',
    footerBackground: '#efe8db',
    texture: 'rgba(17,24,39,0.12)',
  },
  premium: {
    background: '#fbfaf7',
    foreground: '#1f1d1a',
    muted: '#736b5e',
    panel: '#ffffff',
    panelBorder: '#d4c3a1',
    qrFrame: '#ffffff',
    accent: '#9a6a21',
    accent2: '#1f1d1a',
    accent3: '#d7bb7d',
    badgeBackground: '#f2ead9',
    badgeForeground: '#6c4716',
    footerBackground: '#f5efe3',
    texture: 'rgba(154,106,33,0.14)',
  },
  night: {
    background: '#171717',
    foreground: '#fafafa',
    muted: '#d4d4d4',
    panel: '#242424',
    panelBorder: '#3f3f46',
    qrFrame: '#ffffff',
    accent: '#f97316',
    accent2: '#22c55e',
    accent3: '#facc15',
    badgeBackground: '#3a2417',
    badgeForeground: '#fed7aa',
    footerBackground: '#202020',
    texture: 'rgba(250,250,250,0.12)',
  },
};

const posterTypography: Record<QRTemplateStyle, PosterTypography> = {
  fresh: {
    headingFont: '"Trebuchet MS", "Avenir Next", "Segoe UI", Arial, sans-serif',
    headingSize: 48,
    headingWeight: 800,
    headingLineHeight: 0.98,
    labelFont: '"Segoe UI Semibold", "Segoe UI", Arial, sans-serif',
    labelSize: 25,
    labelWeight: 700,
    labelColor: '#0f8f69',
  },
  signal: {
    headingFont: '"Arial Black", "Segoe UI Black", Impact, Arial, sans-serif',
    headingSize: 45,
    headingWeight: 900,
    headingLineHeight: 0.96,
    labelFont: '"Segoe UI Semibold", "Segoe UI", Arial, sans-serif',
    labelSize: 21,
    labelWeight: 800,
    labelColor: '#111827',
    labelTransform: 'uppercase',
  },
  premium: {
    headingFont: 'Georgia, "Times New Roman", serif',
    headingSize: 48,
    headingWeight: 500,
    headingLineHeight: 1,
    labelFont: '"Trebuchet MS", "Segoe UI", Arial, sans-serif',
    labelSize: 21,
    labelWeight: 700,
    labelColor: '#9a6a21',
    labelTransform: 'uppercase',
  },
  night: {
    headingFont: '"Arial Black", "Trebuchet MS", "Segoe UI", Arial, sans-serif',
    headingSize: 43,
    headingWeight: 900,
    headingLineHeight: 0.98,
    labelFont: '"Trebuchet MS", "Segoe UI", Arial, sans-serif',
    labelSize: 23,
    labelWeight: 800,
    labelColor: '#facc15',
    labelTransform: 'uppercase',
  },
};

const createQrCodeUrls = (menuUrl: string, size = 640): string[] => {
  const encodedUrl = encodeURIComponent(menuUrl);
  return [
    `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&ecc=M&margin=1&data=${encodedUrl}`,
    `https://quickchart.io/qr?text=${encodedUrl}&size=${size}&margin=1&ecLevel=M&format=png`,
  ];
};

const blobToDataUrl = (blob: Blob): Promise<string> => (
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read QR image'));
    reader.readAsDataURL(blob);
  })
);

const fetchImageAsDataUrl = async (url: string): Promise<string> => {
  const response = await fetch(url, { cache: 'no-store', mode: 'cors' });
  if (!response.ok) {
    throw new Error(`QR service returned ${response.status}`);
  }

  return blobToDataUrl(await response.blob());
};

const loadQrCodeImage = async (menuUrl: string): Promise<{ serviceUrl: string; dataUrl: string }> => {
  let lastError: unknown;

  for (const serviceUrl of createQrCodeUrls(menuUrl)) {
    try {
      return {
        serviceUrl,
        dataUrl: await fetchImageAsDataUrl(serviceUrl),
      };
    } catch (error) {
      lastError = error;
      console.warn('[QRCodeTemplates] QR service failed, trying fallback:', error);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to load QR image');
};

const waitForNextPaint = () => (
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  })
);

const waitForImages = async (root: HTMLElement): Promise<void> => {
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(
    images.map((image) => {
      if (image.complete && image.naturalWidth > 0) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('QR image did not load in time')), 8000);
        image.onload = () => {
          window.clearTimeout(timeout);
          resolve();
        };
        image.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error('QR image failed to load'));
        };
      });
    })
  );
};

const QRCodePoster = ({
  template,
  qrCodeSrc,
  className,
}: {
  template: QRTemplate;
  qrCodeSrc: string;
  className?: string;
}) => {
  const theme = posterThemes[template.style];
  const typography = posterTypography[template.style];
  const isNight = template.style === 'night';
  const isPremium = template.style === 'premium';
  const isSignal = template.style === 'signal';
  const isFresh = template.style === 'fresh';

  return (
    <div
      data-qr-poster
      className={cn('relative overflow-hidden', className)}
      style={{
        width: POSTER_WIDTH,
        height: POSTER_HEIGHT,
        background: theme.background,
        color: theme.foreground,
        fontFamily: 'Inter, Arial, sans-serif',
        boxSizing: 'border-box',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 18,
          border: `1px solid ${isNight ? 'rgba(250,250,250,0.18)' : theme.panelBorder}`,
          borderRadius: 28,
          pointerEvents: 'none',
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: '0 0 auto 0',
          height: isSignal ? 108 : 92,
          background: isSignal
            ? `linear-gradient(135deg, ${theme.accent} 0 68%, ${theme.accent2} 68% 100%)`
            : `linear-gradient(90deg, ${theme.accent}, ${theme.accent2})`,
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 36,
          right: 36,
          top: isSignal ? 124 : 108,
          display: 'grid',
          gridTemplateColumns: '1fr 42px 1fr',
          alignItems: 'center',
          gap: 14,
          opacity: isNight ? 0.55 : 0.8,
        }}
      >
        <span style={{ height: 1, background: theme.texture }} />
        <span
          style={{
            height: 8,
            borderRadius: 999,
            background: isPremium
              ? theme.accent3
              : `linear-gradient(90deg, ${theme.accent}, ${theme.accent2})`,
          }}
        />
        <span style={{ height: 1, background: theme.texture }} />
      </div>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 34,
          top: 34,
          width: 52,
          height: 52,
          borderLeft: `5px solid ${isSignal ? theme.accent2 : theme.accent3}`,
          borderTop: `5px solid ${isSignal ? theme.accent2 : theme.accent3}`,
          borderRadius: '18px 0 0 0',
          opacity: isNight ? 0.95 : 0.9,
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          right: 34,
          bottom: 34,
          width: 52,
          height: 52,
          borderRight: `5px solid ${isNight ? theme.accent : theme.accent}`,
          borderBottom: `5px solid ${isNight ? theme.accent : theme.accent}`,
          borderRadius: '0 0 18px 0',
          opacity: isNight ? 0.95 : 0.8,
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          right: isFresh ? 42 : 54,
          top: isFresh ? 56 : 58,
          width: isFresh ? 86 : 66,
          height: isFresh ? 18 : 14,
          borderRadius: 999,
          background: isSignal ? theme.accent2 : isNight ? theme.accent : theme.accent3,
          transform: isSignal ? 'rotate(-18deg)' : 'rotate(-8deg)',
          opacity: isNight ? 0.78 : 0.9,
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: -28,
          bottom: 94,
          width: 122,
          height: 16,
          borderRadius: 999,
          background: isPremium ? theme.accent3 : theme.accent2,
          transform: 'rotate(-42deg)',
          opacity: isNight ? 0.6 : 0.72,
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `linear-gradient(${theme.texture} 1px, transparent 1px), linear-gradient(90deg, ${theme.texture} 1px, transparent 1px)`,
          backgroundSize: isPremium ? '46px 46px' : '38px 38px',
          opacity: isSignal ? 0.2 : 0.32,
          maskImage: 'linear-gradient(to bottom, transparent 0 16%, black 34% 86%, transparent 100%)',
        }}
      />
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          height: '100%',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 32,
          padding: '114px 40px 54px',
        }}
      >
        <div
          style={{
            maxWidth: 340,
            textAlign: 'center',
            padding: '0 8px',
          }}
        >
          <div
            style={{
              margin: 0,
              color: theme.foreground,
            }}
          >
            <span
              style={{
                display: 'block',
                fontFamily: typography.headingFont,
                fontSize: typography.headingSize,
                fontWeight: typography.headingWeight,
                lineHeight: typography.headingLineHeight,
                letterSpacing: 0,
              }}
            >
              Scan here
            </span>
            <span
              style={{
                display: 'block',
                marginTop: 9,
                fontFamily: typography.labelFont,
                fontSize: typography.labelSize,
                fontWeight: typography.labelWeight,
                lineHeight: 1.05,
                color: typography.labelColor,
                letterSpacing: 0,
                textTransform: typography.labelTransform,
              }}
            >
              for our menu
            </span>
          </div>
        </div>

        <div
          style={{
            position: 'relative',
            width: QR_SIZE + 64,
            border: `1px solid ${isNight ? 'rgba(255,255,255,0.16)' : theme.panelBorder}`,
            borderRadius: 30,
            background: theme.panel,
            padding: 24,
            boxShadow: isNight
              ? '0 20px 50px rgba(0,0,0,0.35)'
              : '0 18px 44px rgba(20,20,20,0.14)',
          }}
        >
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 10,
              border: `1px dashed ${isNight ? 'rgba(255,255,255,0.16)' : theme.panelBorder}`,
              borderRadius: 22,
              pointerEvents: 'none',
            }}
          />
          <div
            style={{
              position: 'relative',
              borderRadius: 20,
              background: theme.qrFrame,
              padding: 14,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <img
              src={qrCodeSrc}
              alt="Menu QR Code"
              crossOrigin="anonymous"
              style={{
                display: 'block',
                width: QR_SIZE,
                height: QR_SIZE,
                objectFit: 'contain',
                imageRendering: 'pixelated',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export function QRCodeTemplates({
  publicMenuUrl,
}: {
  publicMenuUrl: string;
  businessName?: string;
}) {
  const { toast } = useToast();
  const exportRef = useRef<HTMLDivElement>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<QRTemplate | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [isQrLoading, setIsQrLoading] = useState(false);
  const [generatingTemplateId, setGeneratingTemplateId] = useState<string | null>(null);
  const [exportJob, setExportJob] = useState<{ template: QRTemplate; qrCodeSrc: string } | null>(null);

  const qrCodeSrc = qrCodeDataUrl || qrCodeUrl;
  const canExport = Boolean(publicMenuUrl && qrCodeSrc && !isQrLoading);

  const syncQrCode = useCallback(async (menuUrl: string) => {
    const serviceUrl = createQrCodeUrls(menuUrl)[0];
    setQrCodeUrl(serviceUrl);
    setQrCodeDataUrl('');
    setIsQrLoading(true);

    try {
      const { serviceUrl: loadedServiceUrl, dataUrl } = await loadQrCodeImage(menuUrl);
      setQrCodeUrl(loadedServiceUrl);
      setQrCodeDataUrl(dataUrl);
    } catch (error) {
      console.warn('[QRCodeTemplates] Failed to embed QR image as data URL. Falling back to remote image:', error);
      setQrCodeDataUrl('');
    } finally {
      setIsQrLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!publicMenuUrl) {
      setQrCodeUrl('');
      setQrCodeDataUrl('');
      setIsQrLoading(false);
      return;
    }

    void syncQrCode(publicMenuUrl);
  }, [publicMenuUrl, syncQrCode]);

  const ensureQrCodeSource = async () => {
    if (!publicMenuUrl) {
      throw new Error('Public menu URL is not ready');
    }

    if (qrCodeDataUrl) {
      return qrCodeDataUrl;
    }

    const { serviceUrl, dataUrl } = await loadQrCodeImage(publicMenuUrl);
    setQrCodeUrl(serviceUrl);
    setQrCodeDataUrl(dataUrl);
    return dataUrl;
  };

  const renderExportCanvas = async (template: QRTemplate) => {
    const embeddedQrCode = await ensureQrCodeSource();
    setExportJob({ template, qrCodeSrc: embeddedQrCode });
    await waitForNextPaint();

    const target = exportRef.current?.querySelector<HTMLElement>('[data-qr-poster]');
    if (!target) {
      throw new Error('Could not prepare QR poster');
    }

    await waitForImages(target);
    await waitForNextPaint();

    return html2canvas(target, {
      backgroundColor: null,
      scale: 3,
      useCORS: true,
      allowTaint: false,
      logging: false,
      imageTimeout: 10000,
      width: POSTER_WIDTH,
      height: POSTER_HEIGHT,
      windowWidth: POSTER_WIDTH,
      windowHeight: POSTER_HEIGHT,
    });
  };

  const handleDownloadPNG = async (template: QRTemplate) => {
    if (!canExport) {
      toast({
        variant: 'destructive',
        title: 'QR Code not ready',
        description: 'Please wait for the QR code to load.',
      });
      return;
    }

    setGeneratingTemplateId(template.id);
    try {
      const canvas = await renderExportCanvas(template);
      const pngDataUrl = canvas.toDataURL('image/png');

      if (!pngDataUrl || pngDataUrl === 'data:,') {
        throw new Error('Failed to generate PNG from canvas');
      }

      const link = document.createElement('a');
      link.href = pngDataUrl;
      link.download = `qr-menu-${template.id}-${new Date().toISOString().split('T')[0]}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      toast({
        title: 'PNG downloaded',
        description: `${template.name} QR design is ready for printing.`,
      });
    } catch (error) {
      console.error('Error generating PNG:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to generate PNG. Please try again.',
      });
    } finally {
      setExportJob(null);
      setGeneratingTemplateId(null);
    }
  };

  const handleDownloadPDF = async (template: QRTemplate) => {
    if (!canExport) {
      toast({
        variant: 'destructive',
        title: 'QR Code not ready',
        description: 'Please wait for the QR code to load.',
      });
      return;
    }

    setGeneratingTemplateId(template.id);
    try {
      const canvas = await renderExportCanvas(template);
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
      });

      const imgWidth = 148;
      const imgHeight = (POSTER_HEIGHT * imgWidth) / POSTER_WIDTH;
      const x = (210 - imgWidth) / 2;
      const y = 16;

      pdf.addImage(imgData, 'PNG', x, y, imgWidth, imgHeight);
      pdf.save(`qr-menu-${template.id}-${new Date().toISOString().split('T')[0]}.pdf`);

      toast({
        title: 'PDF downloaded',
        description: `${template.name} QR design is ready for printing.`,
      });
    } catch (error) {
      console.error('Error generating PDF:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to generate PDF. Please try again.',
      });
    } finally {
      setExportJob(null);
      setGeneratingTemplateId(null);
    }
  };

  const handlePreview = (template: QRTemplate) => {
    setSelectedTemplate(template);
    setIsPreviewOpen(true);
  };

  const previewTemplate = selectedTemplate ?? qrTemplates[0];

  const emptyUrlMessage = useMemo(() => {
    if (publicMenuUrl) {
      return null;
    }
    return 'Public menu URL is not ready yet.';
  }, [publicMenuUrl]);

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {qrTemplates.map((template) => {
          const isGenerating = generatingTemplateId === template.id;

          return (
            <Card key={template.id} className="flex overflow-hidden">
              <div className="flex w-full flex-col">
                <div className="border-b bg-muted/40 p-3">
                  <div className="mx-auto h-[210px] w-[150px] overflow-hidden rounded-md border bg-background shadow-sm">
                    {qrCodeSrc ? (
                      <QRCodePoster
                        template={template}
                        qrCodeSrc={qrCodeSrc}
                        className="origin-top-left scale-[0.3125]"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-muted-foreground">
                        <QrCodeIcon className="h-10 w-10" />
                      </div>
                    )}
                  </div>
                </div>

                <CardHeader className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-base">{template.name}</CardTitle>
                      <CardDescription className="mt-1 line-clamp-2">{template.description}</CardDescription>
                    </div>
                    <Badge variant="outline" className="shrink-0">
                      PNG
                    </Badge>
                  </div>
                </CardHeader>

                <CardContent className="flex flex-1 flex-col gap-4">
                  <div className="flex flex-wrap gap-1">
                    {template.features.map((feature) => (
                      <Badge key={feature} variant="secondary" className="text-xs">
                        {feature}
                      </Badge>
                    ))}
                  </div>

                  <div className="mt-auto grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePreview(template)}
                      disabled={!qrCodeSrc}
                    >
                      <Eye className="mr-2 h-4 w-4" />
                      Preview
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" disabled={!canExport || isGenerating}>
                          {isGenerating ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Download className="mr-2 h-4 w-4" />
                          )}
                          Export
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleDownloadPNG(template)}>
                          <FileImage className="mr-2 h-4 w-4" />
                          PNG
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDownloadPDF(template)}>
                          <FileText className="mr-2 h-4 w-4" />
                          PDF
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </CardContent>
              </div>
            </Card>
          );
        })}
      </div>

      {emptyUrlMessage && (
        <p className="mt-3 text-sm text-muted-foreground">{emptyUrlMessage}</p>
      )}

      <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>Preview: {previewTemplate.name}</DialogTitle>
            <DialogDescription>
              Print-ready QR design for your customer-facing menu.
            </DialogDescription>
          </DialogHeader>
          {qrCodeSrc && (
            <div className="flex-1 overflow-auto rounded-lg border bg-muted p-4">
              <div className="mx-auto w-fit overflow-hidden rounded-md bg-background shadow-sm">
                <QRCodePoster
                  template={previewTemplate}
                  qrCodeSrc={qrCodeSrc}
                />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <div
        ref={exportRef}
        aria-hidden="true"
        style={{
          position: 'fixed',
          left: -10000,
          top: 0,
          width: POSTER_WIDTH,
          height: POSTER_HEIGHT,
          overflow: 'hidden',
          pointerEvents: 'none',
          zIndex: -1,
        }}
      >
        {exportJob && (
          <QRCodePoster
            template={exportJob.template}
            qrCodeSrc={exportJob.qrCodeSrc}
          />
        )}
      </div>
    </>
  );
}
