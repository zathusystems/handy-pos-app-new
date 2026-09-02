'use client';

import React, { useEffect, useState } from 'react';
import { HandyPosLogo } from '@/components/icons/logo';
import { MapPin, Phone, Mail, Globe, Loader2 } from 'lucide-react';
import { authFetch } from '@/lib/auth-fetch';

interface BusinessInfo {
  id: string;
  name: string;
  type: string;
  email?: string;
  phone?: string;
  address?: string;
  website?: string;
  currency?: string;
}

export default function MenuLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [businessInfo, setBusinessInfo] = useState<BusinessInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadBusinessInfo = async () => {
      try {
        console.log('[Menu] Fetching business info from backend...');
        const response = await authFetch.fetch('/business/');
        
        if (response && response.results && response.results.length > 0) {
          const business = response.results[0];
          console.log('[Menu] Business info loaded:', business);
          const currency = business.currency || business.settings?.currency;
          setBusinessInfo({
            id: business.id,
            name: business.name,
            type: business.type,
            email: business.email,
            phone: business.phone,
            address: business.address,
            website: business.website,
            currency,
          });
        } else {
          console.warn('[Menu] No business info found from backend');
        }
      } catch (error) {
        console.error('[Menu] Failed to load business info from backend:', error);
      } finally {
        setLoading(false);
      }
    };

    loadBusinessInfo();
  }, []);

  return (
    <main className="tauri-android-content-safe-bottom flex min-h-screen min-h-[100dvh] w-full flex-col items-center bg-gradient-to-b from-background to-muted/40 p-4 sm:p-8">
      {/* Header with Business Info */}
      <div className="mb-8 w-full max-w-4xl">
        <div className="mb-6 flex w-full items-start gap-4 rounded-lg border border-border bg-card p-6 shadow-sm">
          <HandyPosLogo className="h-16 w-16 flex-shrink-0" />
          <div className="flex-1">
            {loading ? (
              <div className="flex items-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-muted-foreground">Loading business info...</span>
              </div>
            ) : (
              <>
                <h1 className="text-3xl font-bold tracking-tight">
                  {businessInfo?.name || 'Restaurant Menu'}
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {businessInfo?.type || 'Digital Menu'}
                </p>
                
                {/* Business Contact Info */}
                {businessInfo && (
                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {businessInfo.address && (
                      <div className="flex items-center gap-2 text-sm text-foreground">
                        <MapPin className="h-4 w-4 text-primary" />
                        <span>{businessInfo.address}</span>
                      </div>
                    )}
                    {businessInfo.phone && (
                      <div className="flex items-center gap-2 text-sm text-foreground">
                        <Phone className="h-4 w-4 text-primary" />
                        <a href={`tel:${businessInfo.phone}`} className="hover:underline">
                          {businessInfo.phone}
                        </a>
                      </div>
                    )}
                    {businessInfo.email && (
                      <div className="flex items-center gap-2 text-sm text-foreground">
                        <Mail className="h-4 w-4 text-primary" />
                        <a href={`mailto:${businessInfo.email}`} className="hover:underline">
                          {businessInfo.email}
                        </a>
                      </div>
                    )}
                    {businessInfo.website && (
                      <div className="flex items-center gap-2 text-sm text-foreground">
                        <Globe className="h-4 w-4 text-primary" />
                        <a href={businessInfo.website} target="_blank" rel="noopener noreferrer" className="hover:underline">
                          Visit Website
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Menu Content */}
      <div className="w-full max-w-4xl">
        {children}
      </div>
    </main>
  );
}
