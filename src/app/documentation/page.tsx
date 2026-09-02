import Link from 'next/link';
import {
  Archive,
  BarChart3,
  Boxes,
  Building2,
  ChefHat,
  ClipboardList,
  CreditCard,
  HelpCircle,
  MonitorPlay,
  PackageSearch,
  Printer,
  QrCode,
  ReceiptText,
  RefreshCw,
  ScanLine,
  Settings,
  ShieldCheck,
  ShoppingBasket,
  Store,
  Users,
  Utensils,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { HandyPosLogo } from '@/components/icons/logo';

const quickLinks = [
  { href: '#getting-started', label: 'Getting Started' },
  { href: '#business-types', label: 'Business Types' },
  { href: '#pos', label: 'POS' },
  { href: '#orders', label: 'Orders' },
  { href: '#kitchen', label: 'Kitchen' },
  { href: '#menu', label: 'Menu and QR' },
  { href: '#inventory', label: 'Inventory' },
  { href: '#sessions', label: 'Sessions' },
  { href: '#staff', label: 'Staff' },
  { href: '#billing', label: 'Billing' },
  { href: '#settings', label: 'Settings' },
  { href: '#offline', label: 'Offline Sync' },
  { href: '#troubleshooting', label: 'Troubleshooting' },
];

const overviewCards = [
  {
    title: 'Sell and serve',
    description: 'Use POS, waiter orders, bills, receipts, and order processing from one flow.',
    icon: MonitorPlay,
  },
  {
    title: 'Control stock',
    description: 'Track purchased items, recipes, ingredients, portions, low stock, transfers, and audits.',
    icon: Boxes,
  },
  {
    title: 'Run restaurant workflows',
    description: 'For restaurants and bars, route prepared orders to kitchen screens and process sales when ready.',
    icon: ChefHat,
  },
  {
    title: 'Publish a QR menu',
    description: 'Show menu items online, hide unavailable items, and generate QR or printable menu templates.',
    icon: QrCode,
  },
];

const dailyWorkflow = [
  'Choose the active branch before selling, receiving stock, or viewing reports.',
  'Start or confirm the active POS session so sales and cash totals are tracked correctly.',
  'Process counter sales directly in POS, or use Orders when staff need to take table/customer requests.',
  'For restaurants and bars, send prepared items to the kitchen screen when kitchen work is needed.',
  'Print a bill before payment when customers eat or drink first, then complete payment after review.',
  'Check low stock, failed sync items, and unattended orders before closing the day.',
  'Close the session and review sales, payments, stock movement, and staff activity.',
];

const businessTypeGuides = [
  {
    title: 'Restaurant and Bar',
    description: 'Use table orders, QR ordering, kitchen screens, recipes, ingredients, drink portions, bills, and waiter roles.',
  },
  {
    title: 'Supermarket and Grocery',
    description: 'Use barcode-friendly POS, purchase records, stock counts, low stock alerts, suppliers, and fast item lookup.',
  },
  {
    title: 'Clothing and Fashion',
    description: 'Use SKUs, size and color naming, categories, purchase stock, sales reports, and stock audits.',
  },
  {
    title: 'Hardware',
    description: 'Use units, quantities, purchase costs, suppliers, branch stock, stock transfers, and item search.',
  },
  {
    title: 'Pharmacy',
    description: 'Use batches where configured, expiry awareness, inventory controls, low stock alerts, and sales records.',
  },
  {
    title: 'Beauty Salon and Spa',
    description: 'Use POS for services/products, inventory for supplies, expense tracking, staff activity, and reports.',
  },
];

const featureSections = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    icon: Store,
    points: [
      'Create an account, then complete onboarding by entering business name, category, country, contact details, currency, and optional referral code.',
      'The business category changes the language and available workflows. Kitchen is only active for restaurant and bar businesses.',
      'Onboarding uses the configured free-trial duration from the backend. It does not require payment before trying the system.',
      'All applicable features are selected by default during onboarding. You can remove optional add-ons before activating the trial.',
      'After setup, select the correct branch. Branch choice affects inventory, sales, orders, reports, and sync.',
    ],
  },
  {
    id: 'business-types',
    title: 'Business Types',
    icon: Building2,
    points: [
      'Restaurant and bar businesses get kitchen-ready workflows, waiter order taking, QR table ordering, recipes, and portion stock tracking.',
      'Clothing and hardware businesses should use clear product names, categories, SKUs, variants in product names, purchase costs, and branch stock.',
      'Supermarket and grocery businesses should rely on barcode lookup, fast POS search, purchase receiving, low stock alerts, and stock audits.',
      'Pharmacy businesses should pay extra attention to expiry-related fields and stock accuracy.',
      'The public QR menu can act as a showcase and ordering surface for non-restaurant businesses, but kitchen routing stays hidden.',
    ],
  },
  {
    id: 'pos',
    title: 'POS and Sales',
    icon: MonitorPlay,
    points: [
      'Open POS from the dashboard sidebar. The POS adapts to the business type where specialized flows exist.',
      'Search, scan, or select products, add quantities, apply the correct price, then review the cart before payment.',
      'Products with portion setup can be sold as full products or portions where configured.',
      'For restaurants and bars, print a customer bill before payment when the customer eats or drinks first.',
      'Complete payment only when the cashier is ready to finalize the sale. Completed sales update stock and session totals.',
    ],
  },
  {
    id: 'orders',
    title: 'Orders',
    icon: ShoppingBasket,
    points: [
      'The Orders modal is available from the dashboard header and waiter dashboard so staff can respond quickly.',
      'Waiters can take customer orders without needing direct POS access.',
      'Order cards stay compact. Open the order modal to view full customer, table, item, and status details.',
      'For restaurant and bar businesses, orders can be sent to kitchen when preparation is needed.',
      'For other business types, orders skip kitchen routing and can be handled as customer requests or sent for sale processing.',
      'Only the order modal should start sale processing for an order. After sale processing, the order is marked completed and the process-sale action disappears.',
    ],
  },
  {
    id: 'kitchen',
    title: 'Kitchen Screen',
    icon: ChefHat,
    points: [
      'Kitchen is available only for Restaurant and Bar & Liquor business categories.',
      'Kitchen staff see orders that need preparation, with status controls for the preparation workflow.',
      'Order details should show item recipes where a recipe exists, helping staff see ingredients for prepared products.',
      'Purchased products or non-prepared items should not create unnecessary kitchen work for non-restaurant businesses.',
      'When an order is ready, staff can mark it ready so cashier/waiter teams can continue service or sale processing.',
    ],
  },
  {
    id: 'menu',
    title: 'Menu Management and QR Menu',
    icon: QrCode,
    points: [
      'Use Menu Management to create categories, add menu items, upload item images, set prices, and control visibility.',
      'Turn menu items off instead of deleting them when they are temporarily unavailable.',
      'The public customer-facing menu uses the business currency and menu accent color from menu configuration.',
      'QR templates and printable menu templates are generated from the configured business/menu details.',
      'The public menu can accept customer self-orders where online ordering is enabled.',
      'For non-restaurant businesses, the public menu can work as a product showcase and customer ordering surface without kitchen routing.',
    ],
  },
  {
    id: 'inventory',
    title: 'Inventory, Recipes, and Stock',
    icon: Boxes,
    points: [
      'Inventory is the source of truth for sellable products, purchased products, in-house products, ingredients, costs, prices, and stock levels.',
      'Purchased products can use portion setup, useful for bottles, bulk items, or products sold in smaller units.',
      'In-house produced products should use recipes so sales deduct ingredients instead of showing false out-of-stock warnings on the finished product.',
      'Recipes can include ingredients that are also sellable products. Stock deduction follows the recipe quantities configured.',
      'Use purchase records to receive stock, suppliers to track where products came from, and stock transfers for branch movement.',
      'Use stock audits to compare physical stock against system stock and correct differences with approval where required.',
      'Low stock and expiry alerts help catch items that need buying, checking, or removing from sale.',
    ],
  },
  {
    id: 'sessions',
    title: 'POS Sessions and Reports',
    icon: ClipboardList,
    points: [
      'Sessions group sales, cash activity, orders, and stock movement for a shift or business day.',
      'Start a session before selling so reports and cash totals are clean.',
      'Use session details to review sales, payments, discounts, voids, cash movement, and stock tracking.',
      'Close the session after reconciling cash and payment totals.',
      'Reports show business performance, product movement, sales trends, and end-of-day totals.',
    ],
  },
  {
    id: 'staff',
    title: 'Staff and Permissions',
    icon: Users,
    points: [
      'Staff Management lets owners create users and assign roles based on work responsibilities.',
      'Cashiers focus on sales and payment processing. Waiters focus on taking and monitoring orders.',
      'Kitchen Staff focus on preparation screens where kitchen is available.',
      'Managers and admins can access broader operational areas depending on permissions.',
      'If Staff Management is disabled after the trial, non-owner staff access can be deactivated by the system.',
    ],
  },
  {
    id: 'billing',
    title: 'Subscription and Billing',
    icon: CreditCard,
    points: [
      'The free trial uses the configured backend trial duration and creates credits for the selected feature bundle.',
      'All applicable features are selected by default during trial activation.',
      'While free trial credits are active, enabled features cannot be removed from the billing screen.',
      'Adding credits during the trial increases the account balance, but it does not end the trial lock early.',
      'After the trial ends, the account balance is used for ongoing daily billing based on enabled features.',
      'Billing shows daily charges, deposits, current balance, and pricing details.',
    ],
  },
  {
    id: 'settings',
    title: 'Settings, Branches, and Devices',
    icon: Settings,
    points: [
      'Business settings control business profile details, currency, tax details, and feature-specific configuration.',
      'Branch settings control locations and branch-specific operations. Multi-branch is available when enabled.',
      'Printer settings support receipt and bill printing where configured.',
      'Scanner settings support barcode scanning flows where available.',
      'Tax and EIS settings should be completed carefully for businesses that need tax-compliant sales reporting.',
    ],
  },
  {
    id: 'offline',
    title: 'Offline Sync',
    icon: RefreshCw,
    points: [
      'Handy POS keeps local data so common work can continue when the connection is unstable.',
      'The dashboard header shows online/offline state and sync queue status.',
      'Pending items are queued for sync. Failed items need attention when the connection or backend rejects a request.',
      'Avoid logging out, clearing browser data, or switching branches while critical offline work is still pending.',
      'When internet returns, review failed sync items and retry or correct the source data.',
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    icon: HelpCircle,
    points: [
      'If a page is blocked, check that the feature is enabled in Billing and that the staff role has permission.',
      'If kitchen does not show, confirm the business category is Restaurant or Bar & Liquor.',
      'If a public menu price uses the wrong currency, check business settings and menu configuration.',
      'If images do not show, confirm the item image uploaded successfully and that media URLs are served by the backend.',
      'If stock looks wrong after selling recipes, check recipe ingredients, portion quantities, and session stock tracking.',
      'If orders do not update, refresh the Orders modal and check sync status in the dashboard header.',
    ],
  },
];

const setupChecklist = [
  'Confirm business category and currency.',
  'Add branches if needed.',
  'Create product categories.',
  'Add inventory products and costs.',
  'Configure portions for purchased products sold in smaller units.',
  'Create recipes for prepared or in-house products.',
  'Add menu categories and customer-facing menu items.',
  'Upload clear menu item images and hide unavailable items instead of deleting them.',
  'Create staff users and assign roles.',
  'Configure printers, scanners, taxes, and EIS where needed.',
  'Run a test order, kitchen flow, bill print, sale, and session close.',
];

export default function DocumentationPage() {
  return (
    <main className="tauri-android-content-safe-bottom h-screen h-[100dvh] overflow-y-auto bg-background text-foreground">
      <header className="border-b bg-background/95">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <Link href="/" className="flex items-center gap-3">
              <HandyPosLogo className="h-10 w-10" />
              <div>
                <p className="text-base font-semibold">Handy POS</p>
                <p className="text-sm text-muted-foreground">Documentation</p>
              </div>
            </Link>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/login">Login</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/signup">Sign Up</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/dashboard">Dashboard</Link>
              </Button>
            </div>
          </div>
        </div>
      </header>

      <section className="border-b bg-muted/30">
        <div className="mx-auto grid w-full max-w-7xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:px-8">
          <div className="space-y-5">
            <Badge variant="secondary" className="w-fit">Operations manual</Badge>
            <div className="space-y-3">
              <h1 className="max-w-3xl text-3xl font-bold leading-tight sm:text-4xl">
                Handy POS Documentation
              </h1>
              <p className="max-w-3xl text-base leading-7 text-muted-foreground">
                A practical guide for setting up and running Handy POS across retail, restaurant,
                bar, grocery, clothing, hardware, pharmacy, and service businesses.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">POS</Badge>
              <Badge variant="outline">Inventory</Badge>
              <Badge variant="outline">Orders</Badge>
              <Badge variant="outline">Kitchen</Badge>
              <Badge variant="outline">QR Menu</Badge>
              <Badge variant="outline">Billing</Badge>
              <Badge variant="outline">Offline Sync</Badge>
            </div>
          </div>

          <Card className="border bg-background">
            <CardHeader>
              <CardTitle className="text-base">Daily Operating Flow</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3 text-sm text-muted-foreground">
                {dailyWorkflow.map((item, index) => (
                  <li key={item} className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {index + 1}
                    </span>
                    <span className="leading-6">{item}</span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </section>

      <div className="mx-auto grid w-full max-w-7xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[260px_1fr] lg:px-8">
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Contents</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {quickLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="block rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {link.label}
                </Link>
              ))}
            </CardContent>
          </Card>
        </aside>

        <div className="space-y-8">
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {overviewCards.map(({ title, description, icon: Icon }) => (
              <Card key={title}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold">{title}</h2>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </section>

          <section className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold">Business Category Guide</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Choose the closest category during onboarding so Handy POS can show the right workflows.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {businessTypeGuides.map((guide) => (
                <Card key={guide.title}>
                  <CardContent className="p-4">
                    <h3 className="text-sm font-semibold">{guide.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{guide.description}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          <Separator />

          <section className="space-y-5">
            {featureSections.map(({ id, title, icon: Icon, points }) => (
              <Card key={id} id={id} className="scroll-mt-6">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted text-primary">
                      <Icon className="h-5 w-5" />
                    </div>
                    <CardTitle className="text-lg">{title}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-3 text-sm leading-6 text-muted-foreground">
                    {points.map((point) => (
                      <li key={point} className="flex gap-3">
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </section>

          <section className="grid gap-4 lg:grid-cols-[1fr_0.85fr]">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Archive className="h-5 w-5 text-primary" />
                  <CardTitle className="text-lg">Setup Checklist</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
                  {setupChecklist.map((item) => (
                    <li key={item} className="flex gap-3">
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Printer className="h-5 w-5 text-primary" />
                  <CardTitle className="text-lg">Hardware Notes</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-sm leading-6 text-muted-foreground">
                <p>
                  Configure receipt printers before relying on bill or receipt printing during service.
                  Use a test print after selecting a printer.
                </p>
                <p>
                  Barcode scanning depends on scanner setup, camera permission, and product barcode data.
                  For fast checkout, keep product names and barcodes clean.
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Badge variant="outline" className="gap-1">
                    <ScanLine className="h-3.5 w-3.5" />
                    Scanners
                  </Badge>
                  <Badge variant="outline" className="gap-1">
                    <ReceiptText className="h-3.5 w-3.5" />
                    Receipts
                  </Badge>
                  <Badge variant="outline" className="gap-1">
                    <PackageSearch className="h-3.5 w-3.5" />
                    Stock
                  </Badge>
                  <Badge variant="outline" className="gap-1">
                    <Utensils className="h-3.5 w-3.5" />
                    Service
                  </Badge>
                  <Badge variant="outline" className="gap-1">
                    <BarChart3 className="h-3.5 w-3.5" />
                    Reports
                  </Badge>
                </div>
              </CardContent>
            </Card>
          </section>

          <section className="rounded-lg border bg-muted/30 p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Need to start working?</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Open the dashboard if you already have an account, or create one to begin setup.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline">
                  <Link href="/login">Login</Link>
                </Button>
                <Button asChild>
                  <Link href="/signup">Create Account</Link>
                </Button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
