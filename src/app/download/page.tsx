import type { Metadata } from 'next';
import Link from 'next/link';
import { Download, ExternalLink, MonitorDown, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'https://handypos.online';
const installerUrl =
  process.env.NEXT_PUBLIC_DESKTOP_INSTALLER_URL?.trim() ||
  `${siteUrl}/desktop/HandyPOS-Desktop.exe`;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Download Handy POS Desktop App',
  description: 'Download the latest Handy POS desktop installer and follow simple update steps.',
  alternates: {
    canonical: '/download',
  },
  openGraph: {
    title: 'Download Handy POS Desktop App',
    description: 'Get the latest Handy POS desktop installer for your business.',
    url: '/download',
    siteName: 'Handy POS',
    images: [{ url: '/app-icon.png', width: 512, height: 512, alt: 'Handy POS app icon' }],
  },
  twitter: {
    card: 'summary',
    title: 'Download Handy POS Desktop App',
    description: 'Get the latest Handy POS desktop installer for your business.',
    images: ['/app-icon.png'],
  },
};

export default function DownloadPage() {
  return (
    <main className="min-h-screen bg-[#f7f8f5] px-4 py-8 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <section className="grid gap-8 rounded-2xl border bg-background p-6 shadow-sm sm:p-8 lg:grid-cols-[1fr_22rem] lg:items-center">
          <div className="space-y-5">
            <div className="inline-flex items-center gap-2 rounded-full border bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground">
              <MonitorDown className="h-3.5 w-3.5" />
              Desktop update
            </div>
            <div className="space-y-3">
              <h1 className="max-w-2xl text-3xl font-semibold tracking-normal sm:text-4xl">
                Download the latest Handy POS desktop app
              </h1>
              <p className="max-w-2xl text-base leading-7 text-muted-foreground">
                Close Handy POS, download the newest installer, then open the installer to update. Your business data stays in the app and syncs again when you reopen.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="h-11">
                <a href={installerUrl} target="_blank" rel="noreferrer">
                  <Download className="mr-2 h-4 w-4" />
                  Download installer
                </a>
              </Button>
              <Button asChild variant="outline" size="lg" className="h-11">
                <Link href="/documentation">
                  Read documentation
                </Link>
              </Button>
            </div>
          </div>
          <Card className="border bg-muted/30 shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-5 w-5 text-primary" />
                Before installing
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-6 text-muted-foreground">
              <p>Finish any active sale or order first.</p>
              <p>Let pending sync actions complete where possible.</p>
              <p>Close the current Handy POS window before running the installer.</p>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          {[
            {
              title: '1. Download',
              body: 'Open the latest release and download the Windows installer file.',
            },
            {
              title: '2. Install',
              body: 'Run the installer. It will replace the old desktop app with the newer build.',
            },
            {
              title: '3. Reopen',
              body: 'Open Handy POS again and continue working from the same account.',
            },
          ].map((step) => (
            <Card key={step.title} className="shadow-none">
              <CardHeader>
                <CardTitle className="text-base">{step.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm leading-6 text-muted-foreground">{step.body}</CardContent>
            </Card>
          ))}
        </section>

        <div className="rounded-lg border bg-background p-4 text-sm text-muted-foreground">
          Need the download page directly?
          {' '}
          <a href="/download" className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline">
            Open Handy POS download page
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </main>
  );
}
