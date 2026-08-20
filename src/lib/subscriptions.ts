
import { Building, Users, Cloud, CloudOff } from "lucide-react";

export interface Plan {
    id: 'starter' | 'pro';
    name: string;
    price: string;
    priceDescription: string;
    trialDays: number;
    features: string[];
    limitations?: { text: string; icon: React.ElementType }[];
    featured: boolean;
    cta: string;
}

export const plans: Record<Plan['id'], Plan> = {
    starter: {
        id: 'starter',
        name: 'Starter',
        price: '$19',
        priceDescription: 'per month',
        trialDays: 0,
        features: [
            'Full Offline POS Functionality',
            'Inventory Management',
            'Sales Reporting',
            'Customer Management',
        ],
        limitations: [
            { text: 'Single Branch Only', icon: Building },
            { text: 'Single User Account', icon: Users },
            { text: 'No Cloud Sync/Backup', icon: CloudOff },
        ],
        featured: false,
        cta: 'Choose Starter',
    },
    pro: {
        id: 'pro',
        name: 'Pro',
        price: '$49',
        priceDescription: 'per month',
        trialDays: 14,
        features: [
            'All Starter Features',
            'Multi-Branch Support',
            'Unlimited User Accounts',
            'Cloud Data Sync & Backup',
            'Advanced Analytics',
            '3rd-Party Integrations',
        ],
        featured: true,
        cta: 'Start 14-Day Free Trial',
    },
};
