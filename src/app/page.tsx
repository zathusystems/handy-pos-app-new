import type { Metadata } from 'next';

import { LandingPageClient } from '@/components/landing/landing-page-client';

const siteUrl = 'https://handypos.online';
const appUrl = 'https://app.handypos.online';
const title = 'Handy POS | Simple POS, Stock, Orders and Reports';
const description =
  'Handy POS helps restaurants, bars and retail businesses sell faster, track stock, manage orders, handle customer accounts and see clear daily reports.';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: 'Handy POS',
  title,
  description,
  keywords: [
    'Handy POS',
    'POS system',
    'inventory management',
    'restaurant POS',
    'bar POS',
    'QR ordering',
    'kitchen display system',
    'stock tracking',
    'retail POS',
    'Malawi POS',
    'business reports',
    'offline POS',
  ],
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'Handy POS',
    title,
    description,
    images: [
      {
        url: '/app-icon.png',
        width: 512,
        height: 512,
        alt: 'Handy POS app icon',
      },
    ],
    locale: 'en_US',
  },
  twitter: {
    card: 'summary',
    title,
    description,
    images: ['/app-icon.png'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
};

const softwareApplicationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Handy POS',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web, Windows, macOS, Linux, Android',
  url: siteUrl,
  image: `${siteUrl}/app-icon.png`,
  description,
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'MWK',
    description: 'Free trial available. Ongoing billing depends on configured feature selection and account credits.',
  },
  featureList: [
    'Point of sale',
    'Inventory tracking',
    'Restaurant order management',
    'QR menu',
    'Customer accounts',
    'Laybuy and on-account sales',
    'Daily reports',
  ],
  audience: {
    '@type': 'Audience',
    audienceType: 'Restaurants, bars, supermarkets, grocery stores, clothing shops, hardware stores, pharmacies and salons',
  },
};

const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Handy POS',
  url: siteUrl,
  logo: `${siteUrl}/app-icon.png`,
};

const websiteJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'Handy POS',
  url: siteUrl,
  description,
  potentialAction: {
    '@type': 'RegisterAction',
    target: `${appUrl}/signup`,
    name: 'Start a Handy POS free trial',
  },
};

const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What businesses can use Handy POS?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Handy POS supports restaurants, bars, supermarkets, grocery stores, clothing shops, hardware stores, pharmacies, salons and similar retail or service businesses.',
      },
    },
    {
      '@type': 'Question',
      name: 'Does Handy POS support QR ordering and kitchen screens?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Yes. Restaurants and bars can use QR ordering, waiter order taking and kitchen display workflows. Other business types can use the public menu as a showcase and ordering surface without kitchen routing.',
      },
    },
    {
      '@type': 'Question',
      name: 'Does Handy POS track inventory?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Yes. Handy POS tracks inventory, purchased products, portions, ingredients, recipes, low stock, suppliers, stock transfers and stock audits where configured.',
      },
    },
  ],
};

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([
            softwareApplicationJsonLd,
            organizationJsonLd,
            websiteJsonLd,
            faqJsonLd,
          ]),
        }}
      />
      <LandingPageClient />
    </>
  );
}
