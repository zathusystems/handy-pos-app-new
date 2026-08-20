'use client';

import React, { useState } from 'react';
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
import { Download, FileText, Grid3x3, List } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import type { InventoryItem } from '@/lib/db';

type MenuTemplateStyle = 'dining-list' | 'photo-grid' | 'counter-board';

interface MenuTemplateOptions {
  businessName: string;
  currencyCode: string;
}

interface MenuTemplate {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  style: MenuTemplateStyle;
  layout: 'list' | 'grid' | 'table';
  features: string[];
  generateContent: (items: InventoryItem[], options: MenuTemplateOptions) => string;
}

const escapeHtml = (value: unknown): string => (
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
);

const escapeAttribute = (value: unknown): string => escapeHtml(value);

const normalizeCategory = (category: unknown): string => {
  const value = String(category ?? '').trim();
  return value || 'House Favorites';
};

const getMenuDescription = (item: InventoryItem): string => (
  String((item as InventoryItem & { description?: string; menuDescription?: string }).description ?? (item as InventoryItem & { menuDescription?: string }).menuDescription ?? '').trim()
);

const getInitial = (name: string): string => {
  const first = name.trim().charAt(0).toUpperCase();
  return first || 'M';
};

const getPrice = (item: InventoryItem): number => {
  const value = Number(item.price ?? 0);
  return Number.isFinite(value) ? value : 0;
};

const formatMenuPrice = (amount: number, currencyCode: string): string => {
  const normalizedCurrency = String(currencyCode || 'MWK').trim().toUpperCase();
  const maximumFractionDigits = normalizedCurrency === 'MWK' ? 0 : 2;

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: normalizedCurrency,
      maximumFractionDigits,
    }).format(amount);
  } catch {
    const prefix = normalizedCurrency === 'MWK' ? 'MWK' : normalizedCurrency || '$';
    return `${prefix} ${amount.toFixed(maximumFractionDigits)}`;
  }
};

const groupItemsByCategory = (items: InventoryItem[]): Array<[string, InventoryItem[]]> => {
  const groups = new Map<string, InventoryItem[]>();

  items.forEach((item) => {
    const category = normalizeCategory(item.category);
    const existing = groups.get(category) || [];
    existing.push(item);
    groups.set(category, existing);
  });

  return Array.from(groups.entries());
};

const buildPrintableShell = ({
  businessName,
  content,
  css,
  accent = '#263b57',
}: {
  businessName: string;
  content: string;
  css: string;
  accent?: string;
}): string => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(businessName)} Menu</title>
  <style>
    @page {
      size: A4;
      margin: 14mm;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: #f5f1e8;
      color: #171717;
      font-family: "Segoe UI", Arial, sans-serif;
    }

    .sheet {
      max-width: 980px;
      min-height: 100vh;
      margin: 0 auto;
      padding: 42px;
      background: #fffdf8;
      border: 1px solid #e7ddce;
    }

    .menu-header {
      display: grid;
      gap: 10px;
      margin-bottom: 30px;
      text-align: center;
    }

    .menu-kicker {
      margin: 0;
      color: ${accent};
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .menu-title {
      margin: 0;
      color: #151515;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 50px;
      font-weight: 500;
      line-height: 0.98;
      letter-spacing: 0;
    }

    .top-rule {
      width: 86px;
      height: 5px;
      margin: 0 auto 6px;
      border-radius: 999px;
      background: ${accent};
    }

    .price {
      color: ${accent};
      font-weight: 900;
      white-space: nowrap;
    }

    ${css}

    @media print {
      body {
        background: #ffffff;
      }

      .sheet {
        max-width: none;
        min-height: auto;
        margin: 0;
        padding: 0;
        border: 0;
        background: #ffffff;
      }

      .menu-header {
        margin-bottom: 22px;
      }
    }
  </style>
</head>
<body>
  <main class="sheet">
    <header class="menu-header">
      <div class="top-rule"></div>
      <p class="menu-kicker">Menu</p>
      <h1 class="menu-title">${escapeHtml(businessName)}</h1>
    </header>
    ${content}
  </main>
</body>
</html>
`;

const generateDiningListContent = (items: InventoryItem[], options: MenuTemplateOptions): string => {
  const groups = groupItemsByCategory(items);
  const content = groups.map(([category, categoryItems]) => `
    <section class="category-section">
      <div class="category-heading">
        <span>${escapeHtml(category)}</span>
      </div>
      <div class="menu-rows">
        ${categoryItems.map((item) => {
          const description = getMenuDescription(item);
          return `
            <article class="menu-row">
              <div class="item-copy">
                <h2>${escapeHtml(item.name)}</h2>
                ${description ? `<p>${escapeHtml(description)}</p>` : ''}
              </div>
              <p class="price">${escapeHtml(formatMenuPrice(getPrice(item), options.currencyCode))}</p>
            </article>
          `;
        }).join('')}
      </div>
    </section>
  `).join('');

  return buildPrintableShell({
    businessName: options.businessName,
    accent: '#295135',
    content,
    css: `
      .category-section {
        margin-bottom: 30px;
        page-break-inside: avoid;
      }

      .category-heading {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-bottom: 12px;
        color: #295135;
        font-size: 13px;
        font-weight: 900;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      .category-heading::after {
        content: "";
        flex: 1;
        height: 1px;
        background: #d8cfc0;
      }

      .menu-rows {
        display: grid;
        gap: 2px;
      }

      .menu-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 24px;
        padding: 15px 0;
        border-bottom: 1px solid #eee7dc;
        page-break-inside: avoid;
      }

      .item-copy h2 {
        margin: 0;
        color: #171717;
        font-size: 18px;
        font-weight: 800;
        line-height: 1.2;
      }

      .item-copy p {
        max-width: 560px;
        margin: 5px 0 0;
        color: #686056;
        font-size: 13px;
        line-height: 1.45;
      }

      .menu-row .price {
        margin: 1px 0 0;
        font-size: 17px;
      }
    `,
  });
};

const generatePhotoGridContent = (items: InventoryItem[], options: MenuTemplateOptions): string => {
  const content = `
    <section class="photo-grid">
      ${items.map((item) => {
        const image = String(item.image ?? '').trim();
        const category = normalizeCategory(item.category);
        return `
          <article class="photo-card">
            ${
              image
                ? `<img src="${escapeAttribute(image)}" alt="${escapeAttribute(item.name)}">`
                : `<div class="image-fallback"><span>${escapeHtml(getInitial(item.name))}</span></div>`
            }
            <div class="photo-copy">
              <p class="category-pill">${escapeHtml(category)}</p>
              <h2>${escapeHtml(item.name)}</h2>
              <p class="price">${escapeHtml(formatMenuPrice(getPrice(item), options.currencyCode))}</p>
            </div>
          </article>
        `;
      }).join('')}
    </section>
  `;

  return buildPrintableShell({
    businessName: options.businessName,
    accent: '#b34b2b',
    content,
    css: `
      .photo-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }

      .photo-card {
        overflow: hidden;
        border: 1px solid #eadfd0;
        border-radius: 14px;
        background: #ffffff;
        page-break-inside: avoid;
      }

      .photo-card img,
      .image-fallback {
        display: block;
        width: 100%;
        height: 190px;
        object-fit: cover;
        background: #efe6d7;
      }

      .image-fallback {
        display: grid;
        place-items: center;
      }

      .image-fallback span {
        display: grid;
        width: 74px;
        height: 74px;
        place-items: center;
        border-radius: 999px;
        background: #fff8ed;
        color: #b34b2b;
        font-family: Georgia, "Times New Roman", serif;
        font-size: 38px;
        font-weight: 700;
      }

      .photo-copy {
        padding: 16px 16px 18px;
      }

      .category-pill {
        display: inline-flex;
        margin: 0 0 9px;
        padding: 5px 8px;
        border-radius: 999px;
        background: #f7eee2;
        color: #7b4d2a;
        font-size: 10px;
        font-weight: 900;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      .photo-copy h2 {
        min-height: 44px;
        margin: 0 0 12px;
        color: #171717;
        font-size: 20px;
        font-weight: 850;
        line-height: 1.12;
      }

      .photo-copy .price {
        margin: 0;
        font-size: 18px;
      }

      @media print {
        .photo-grid {
          gap: 12px;
        }

        .photo-card {
          border-radius: 10px;
        }
      }
    `,
  });
};

const generateCounterBoardContent = (items: InventoryItem[], options: MenuTemplateOptions): string => {
  const rows = items.map((item, index) => `
    <tr>
      <td class="item-number">${String(index + 1).padStart(2, '0')}</td>
      <td>
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(normalizeCategory(item.category))}</span>
      </td>
      <td class="price">${escapeHtml(formatMenuPrice(getPrice(item), options.currencyCode))}</td>
    </tr>
  `).join('');

  return buildPrintableShell({
    businessName: options.businessName,
    accent: '#111827',
    content: `
      <section class="board-wrap">
        <table>
          <thead>
            <tr>
              <th>No.</th>
              <th>Item</th>
              <th>Price</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </section>
    `,
    css: `
      .board-wrap {
        overflow: hidden;
        border: 2px solid #111827;
        border-radius: 18px;
        page-break-inside: avoid;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th {
        padding: 14px 18px;
        background: #111827;
        color: #ffffff;
        font-size: 11px;
        font-weight: 900;
        letter-spacing: 0;
        text-align: left;
        text-transform: uppercase;
      }

      th:last-child,
      td:last-child {
        text-align: right;
      }

      td {
        padding: 15px 18px;
        border-bottom: 1px solid #e5e0d8;
        vertical-align: top;
      }

      tbody tr:nth-child(even) {
        background: #faf7f1;
      }

      tbody tr:last-child td {
        border-bottom: 0;
      }

      .item-number {
        width: 64px;
        color: #8b8378;
        font-size: 12px;
        font-weight: 900;
      }

      td strong {
        display: block;
        color: #151515;
        font-size: 17px;
        line-height: 1.2;
      }

      td span {
        display: block;
        margin-top: 4px;
        color: #746d63;
        font-size: 12px;
      }

      td.price {
        color: #111827;
        font-size: 17px;
      }

      @media print {
        .board-wrap {
          border-radius: 10px;
        }
      }
    `,
  });
};

const templates: MenuTemplate[] = [
  {
    id: 'dining-list',
    name: 'Dining List',
    description: 'A clean grouped menu with generous spacing for restaurant tables.',
    icon: <List className="h-6 w-6" />,
    style: 'dining-list',
    layout: 'list',
    features: ['Grouped', 'Elegant', 'Print-friendly'],
    generateContent: generateDiningListContent,
  },
  {
    id: 'photo-menu',
    name: 'Photo Menu',
    description: 'Image-led cards for food, drinks, and specials.',
    icon: <Grid3x3 className="h-6 w-6" />,
    style: 'photo-grid',
    layout: 'grid',
    features: ['Images', 'Modern cards', 'Visual'],
    generateContent: generatePhotoGridContent,
  },
  {
    id: 'counter-board',
    name: 'Counter Board',
    description: 'Compact board-style layout for bars, cafes, and quick service.',
    icon: <FileText className="h-6 w-6" />,
    style: 'counter-board',
    layout: 'table',
    features: ['Compact', 'Fast scan', 'Clear prices'],
    generateContent: generateCounterBoardContent,
  },
];

const TemplatePreview = ({ template }: { template: MenuTemplate }) => (
  <div
    className={cn(
      'relative h-40 overflow-hidden border-b bg-[#fffdf8] p-4',
      template.style === 'counter-board' && 'bg-[#f7f3ec]',
      template.style === 'photo-grid' && 'bg-[#fbf1e8]'
    )}
  >
    <div
      className={cn(
        'mx-auto h-full max-w-[220px] rounded-md border bg-white p-3 shadow-sm',
        template.style === 'counter-board' && 'border-neutral-900',
        template.style === 'photo-grid' && 'border-orange-200'
      )}
    >
      <div
        className={cn(
          'mx-auto mb-2 h-1.5 w-12 rounded-full bg-emerald-700',
          template.style === 'counter-board' && 'bg-neutral-950',
          template.style === 'photo-grid' && 'bg-orange-700'
        )}
      />
      <div className="mx-auto mb-3 h-3 w-24 rounded bg-neutral-900/80" />
      {template.style === 'photo-grid' ? (
        <div className="grid grid-cols-2 gap-2">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="overflow-hidden rounded border border-orange-100">
              <div className="h-8 bg-orange-100" />
              <div className="space-y-1 p-1.5">
                <div className="h-1.5 w-10 rounded bg-neutral-900/70" />
                <div className="h-1.5 w-7 rounded bg-orange-700/80" />
              </div>
            </div>
          ))}
        </div>
      ) : template.style === 'counter-board' ? (
        <div className="overflow-hidden rounded border border-neutral-900">
          <div className="h-4 bg-neutral-950" />
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="grid grid-cols-[1fr_32px] gap-2 border-t p-1.5">
              <div className="space-y-1">
                <div className="h-1.5 w-20 rounded bg-neutral-900/80" />
                <div className="h-1.5 w-12 rounded bg-neutral-300" />
              </div>
              <div className="h-1.5 rounded bg-neutral-900/80" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {[0, 1, 2].map((item) => (
            <div key={item} className="border-t border-emerald-100 pt-2">
              <div className="mb-1 h-1.5 w-16 rounded bg-emerald-700/80" />
              <div className="flex justify-between gap-4">
                <div className="h-2 w-28 rounded bg-neutral-900/75" />
                <div className="h-2 w-10 rounded bg-emerald-700/80" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  </div>
);

export function MenuTemplates({
  menuItems,
  businessName = 'Our Menu',
  currencyCode = 'MWK',
}: {
  menuItems: InventoryItem[];
  businessName?: string;
  currencyCode?: string;
}) {
  const { toast } = useToast();
  const [selectedTemplate, setSelectedTemplate] = useState<MenuTemplate | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  const templateOptions: MenuTemplateOptions = {
    businessName,
    currencyCode,
  };

  const handleDownload = (template: MenuTemplate) => {
    if (menuItems.length === 0) {
      toast({
        variant: 'destructive',
        title: 'No items to download',
        description: 'Add items to your menu before downloading a template.',
      });
      return;
    }

    const content = template.generateContent(menuItems, templateOptions);
    const blob = new Blob([content], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `menu-${template.id}-${new Date().toISOString().split('T')[0]}.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    toast({
      title: 'Menu downloaded',
      description: `${template.name} is ready to open and print.`,
    });
  };

  const handlePreview = (template: MenuTemplate) => {
    setSelectedTemplate(template);
    setIsPreviewOpen(true);
  };

  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        {templates.map((template) => (
          <Card key={template.id} className="flex overflow-hidden">
            <div className="flex w-full flex-col">
              <TemplatePreview template={template} />
              <CardHeader className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="rounded-md bg-primary/10 p-2 text-primary">
                      {template.icon}
                    </div>
                    <div className="min-w-0">
                      <CardTitle className="text-base">{template.name}</CardTitle>
                      <CardDescription className="mt-1 line-clamp-2">
                        {template.description}
                      </CardDescription>
                    </div>
                  </div>
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
                    disabled={menuItems.length === 0}
                  >
                    Preview
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => handleDownload(template)}
                    disabled={menuItems.length === 0}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Download
                  </Button>
                </div>
              </CardContent>
            </div>
          </Card>
        ))}
      </div>

      <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <DialogContent className="flex max-h-[88vh] max-w-5xl flex-col">
          <DialogHeader>
            <DialogTitle>Preview: {selectedTemplate?.name}</DialogTitle>
            <DialogDescription>
              Print-ready menu layout using your visible menu items.
            </DialogDescription>
          </DialogHeader>
          {selectedTemplate && (
            <div className="flex-1 overflow-y-auto rounded-lg border bg-muted p-3">
              <iframe
                srcDoc={selectedTemplate.generateContent(menuItems, templateOptions)}
                className="h-[620px] w-full rounded-md border bg-white"
                title="Menu Preview"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
