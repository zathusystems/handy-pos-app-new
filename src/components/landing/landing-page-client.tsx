'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  BarChart3,
  Boxes,
  CheckCircle2,
  ChefHat,
  CreditCard,
  MonitorPlay,
  QrCode,
  ReceiptText,
  ShoppingBasket,
  Smartphone,
  Users,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HandyPosLogo } from '@/components/icons/logo';
import { isTauriApp } from '@/lib/tauri-init';

const shouldSkipLandingForBuild =
  String(process.env.NEXT_PUBLIC_HIDE_LANDING || '').trim().toLowerCase() === 'true';
const appHosts = new Set(['app.handypos.online']);
const appOrigin = String(process.env.NEXT_PUBLIC_APP_ORIGIN || 'https://app.handypos.online').replace(/\/$/, '');
const getAppUrl = (path: string) => `${appOrigin}${path.startsWith('/') ? path : `/${path}`}`;

const heroBenefits = [
  'Fast sales and receipts',
  'Stock that updates as you sell',
  'Orders, kitchen, and QR menu where needed',
];

const coreFeatures = [
  {
    title: 'POS',
    description: 'Process sales, print bills, accept payments, and keep clean shift totals.',
    icon: MonitorPlay,
  },
  {
    title: 'Inventory',
    description: 'Track products, portions, purchases, low stock, transfers, and stock audits.',
    icon: Boxes,
  },
  {
    title: 'Restaurant Orders',
    description: 'Take table orders, send prepared items to the kitchen, then process payment.',
    icon: ChefHat,
  },
  {
    title: 'QR Menu',
    description: 'Let customers browse your menu or product list from their phone.',
    icon: QrCode,
  },
  {
    title: 'Customers',
    description: 'Attach sales to customers, manage credit accounts, laybuy, and payment history.',
    icon: Users,
  },
  {
    title: 'Reports',
    description: 'See sales, stock movement, unpaid balances, and end-of-day performance.',
    icon: BarChart3,
  },
];

const businessTypes = [
  'Restaurants',
  'Bars',
  'Supermarkets',
  'Grocery stores',
  'Clothing shops',
  'Hardware stores',
  'Pharmacies',
  'Salons',
];

const workflowSteps = [
  { label: 'Sell', icon: CreditCard },
  { label: 'Track stock', icon: Boxes },
  { label: 'Manage orders', icon: ShoppingBasket },
  { label: 'Report daily', icon: ReceiptText },
];

export function LandingPageClient() {
  const router = useRouter();
  const [isOpeningApp, setIsOpeningApp] = useState(shouldSkipLandingForBuild);

  useEffect(() => {
    const host = window.location.hostname.toLowerCase();
    if (shouldSkipLandingForBuild || isTauriApp() || appHosts.has(host)) {
      setIsOpeningApp(true);
      router.replace('/dashboard');
    }
  }, [router]);

  if (isOpeningApp) {
    return (
      <main className="tauri-android-content-safe-bottom flex h-[100dvh] items-center justify-center bg-background px-4">
        <div className="text-center">
          <HandyPosLogo className="mx-auto h-16 w-16" />
          <h1 className="mt-4 text-xl font-semibold">Opening Handy POS</h1>
          <p className="mt-2 text-sm text-muted-foreground">Taking you to the app workspace...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="tauri-android-content-safe-bottom h-[100dvh] overflow-y-auto overscroll-contain bg-[#f7f8f5] text-[#171815]">
      <header className="sticky top-0 z-20 border-b border-black/10 bg-[#f7f8f5]/92 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex min-w-0 items-center gap-3">
            <HandyPosLogo className="h-9 w-9 shrink-0" />
            <span className="truncate text-base font-semibold">Handy POS</span>
          </Link>
          <nav className="hidden items-center gap-6 text-sm text-[#5f6258] md:flex">
            <a href="#features" className="hover:text-[#171815]">Features</a>
            <a href="#businesses" className="hover:text-[#171815]">Businesses</a>
            <Link href="/documentation" className="hover:text-[#171815]">Docs</Link>
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <a href={getAppUrl('/login')}>Login</a>
            </Button>
            <Button asChild size="sm">
              <a href={getAppUrl('/signup')}>Start Trial</a>
            </Button>
          </div>
        </div>
      </header>

      <section className="border-b border-black/10">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[1fr_0.82fr] lg:px-8 lg:py-20">
          <div className="flex flex-col justify-center">
            <Badge variant="secondary" className="mb-5 w-fit border-black/10 bg-white text-[#3d4037]">
              POS for shops, restaurants, and growing teams
            </Badge>
            <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-normal text-[#171815] sm:text-5xl lg:text-6xl">
              Sell faster. Know your stock. Keep every order moving.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-8 text-[#56594f] sm:text-lg">
              Handy POS brings sales, inventory, customer accounts, QR menus, kitchen orders,
              and daily reports into one clear workspace.
            </p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="justify-center">
                <a href={getAppUrl('/signup')}>
                  Start Free Trial
                  <ArrowRight className="ml-2 h-4 w-4" />
                </a>
              </Button>
              <Button asChild size="lg" variant="outline" className="justify-center border-black/15 bg-white">
                <Link href="/documentation">View Documentation</Link>
              </Button>
            </div>
            <div className="mt-7 grid gap-3 text-sm text-[#4f5348] sm:grid-cols-3">
              {heroBenefits.map((benefit) => (
                <div key={benefit} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
                  <span>{benefit}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="relative">
            <div className="rounded-[8px] border border-black/10 bg-white p-4 shadow-[0_24px_70px_rgba(30,31,27,0.12)]">
              <div className="flex items-center justify-between border-b border-black/10 pb-4">
                <div className="flex items-center gap-3">
                  <HandyPosLogo className="h-10 w-10" />
                  <div>
                    <p className="text-sm font-semibold">Today at a glance</p>
                    <p className="text-xs text-[#74776d]">Main branch</p>
                  </div>
                </div>
                <Badge className="bg-emerald-700 text-white">Live</Badge>
              </div>

              <div className="mt-4 grid gap-3">
                {workflowSteps.map(({ label, icon: Icon }, index) => (
                  <div key={label} className="flex items-center justify-between rounded-[6px] border border-black/10 bg-[#fbfbf8] p-4">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-[6px] bg-[#e9efe2] text-emerald-800">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="text-sm font-medium">{label}</span>
                    </div>
                    <span className="text-xs text-[#74776d]">0{index + 1}</span>
                  </div>
                ))}
              </div>

              <div className="mt-4 rounded-[6px] bg-[#1f211d] p-4 text-white">
                <div className="flex items-center gap-2">
                  <Smartphone className="h-4 w-4 text-emerald-300" />
                  <p className="text-sm font-semibold">Works on web, desktop, and mobile builds.</p>
                </div>
                <p className="mt-2 text-sm leading-6 text-white/70">
                  Use the browser in the office, desktop at the counter, and mobile where the work happens.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-normal">What you actually need day to day</h2>
          <p className="mt-2 text-sm leading-6 text-[#5f6258]">
            No bloated setup. Start with the tools that keep sales, stock, and staff work in order.
          </p>
        </div>
        <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {coreFeatures.map(({ title, description, icon: Icon }) => (
            <div key={title} className="rounded-[8px] border border-black/10 bg-white p-5">
              <Icon className="h-5 w-5 text-emerald-800" />
              <h3 className="mt-4 text-base font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-[#5f6258]">{description}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="businesses" className="border-y border-black/10 bg-white">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-12 sm:px-6 lg:grid-cols-[0.85fr_1.15fr] lg:px-8">
          <div>
            <h2 className="text-2xl font-semibold tracking-normal">Fits more than one kind of business</h2>
            <p className="mt-3 text-sm leading-6 text-[#5f6258]">
              Restaurant and bar tools stay available where they belong. Retail businesses get a simpler
              sales and stock flow without kitchen clutter.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {businessTypes.map((type) => (
              <Badge key={type} variant="outline" className="border-black/15 bg-[#f7f8f5] px-3 py-1.5 text-sm">
                {type}
              </Badge>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="rounded-[8px] border border-black/10 bg-[#1f211d] p-6 text-white sm:p-8">
          <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-normal">Ready to try Handy POS?</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/70">
                Create your workspace, choose your business type, and start with the trial configured for your account.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button asChild variant="secondary">
                <a href={getAppUrl('/signup')}>Start Free Trial</a>
              </Button>
              <Button asChild variant="outline" className="border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white">
                <a href={getAppUrl('/login')}>Login</a>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
