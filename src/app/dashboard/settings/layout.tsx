
'use client';

import { usePathname, useRouter } from 'next/navigation';
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  // Determine the active tab from the URL path
  const activeTab = pathname === '/dashboard/settings'
    ? 'business'
    : pathname.split('/').pop() || 'business';

  const onTabChange = (value: string) => {
    if (value === 'business') {
        router.push('/dashboard/settings');
    } else {
        router.push(`/dashboard/settings/${value}`);
    }
  };

  return (
    <div className="space-y-6">
       <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your account settings and business configurations.
        </p>
      </div>
      
      <Tabs value={activeTab} onValueChange={onTabChange} className="flex flex-col gap-6 md:flex-row">
        <TabsList className="flex h-full flex-col justify-start md:w-48">
          <TabsTrigger value="business" className="w-full justify-start">Business</TabsTrigger>
          <TabsTrigger value="billing" className="w-full justify-start">Billing</TabsTrigger>
          <TabsTrigger value="branches" className="w-full justify-start">Branches</TabsTrigger>
            <TabsTrigger value="taxes" className="w-full justify-start">Taxes</TabsTrigger>
          {/* <TabsTrigger value="eis" className="w-full justify-start">MRA EIS</TabsTrigger> */}
          <TabsTrigger value="printers" className="w-full justify-start">Printers</TabsTrigger>
        </TabsList>
        
        <div className="flex-1">
          {children}
        </div>
      </Tabs>
    </div>
  );
}
