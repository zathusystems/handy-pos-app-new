'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { DollarSign, Users, Percent, Wallet, Copy, Gift, ChevronsRight, CheckCircle, Download, Megaphone, Image as ImageIcon, Loader2 } from 'lucide-react';
import { format } from 'date-fns';

import { authFetch } from '@/lib/auth-fetch';
import { useAuth } from '@/hooks/use-auth';
import { useCurrency } from '@/hooks/use-currency';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { HandyPosLogo } from '@/components/icons/logo';
import Image from 'next/image';

interface AffiliateData {
  id: number;
  affiliate_code: string;
  status: string;
  total_referred_businesses: number;
  total_active_referrals: number;
  total_commissions: number;
  total_paid: number;
  joined_date: string;
  company_name?: string;
  website?: string;
  phone?: string;
  address?: string;
  bank_account?: string;
  bank_name?: string;
  account_holder?: string;
  swift_code?: string;
}

interface BusinessReferral {
  id: number;
  business_name: string;
  created_at: string;
  status: string;
}

interface Commission {
  id: number;
  business_name: string;
  commission_amount: number;
  earned_date: string;
  status: string;
}

const KpiCard = ({ title, value, icon: Icon, description }: { title: string, value: string | number, icon: React.ElementType, description: string }) => (
    <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{title}</CardTitle>
            <Icon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
            <div className="text-2xl font-bold">{value}</div>
            <p className="text-xs text-muted-foreground">{description}</p>
        </CardContent>
    </Card>
);

const MarketingCopyCard = ({ title, content }: { title: string, content: string }) => {
    const handleCopy = () => {
        navigator.clipboard.writeText(content);
        toast({ title: "Copied to clipboard!" });
    };
    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-base">{title}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground border-l-2 pl-4">{content}</p>
                <Button variant="outline" size="sm" onClick={handleCopy}>
                    <Copy className="mr-2 h-3 w-3" /> Copy Text
                </Button>
            </CardContent>
        </Card>
    )
};

export default function AffiliatePage() {
    const { user } = useAuth();
    const { format: formatCurrency } = useCurrency();
    
    const [affiliate, setAffiliate] = useState<AffiliateData | null>(null);
    const [referrals, setReferrals] = useState<BusinessReferral[]>([]);
    const [commissions, setCommissions] = useState<Commission[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [editData, setEditData] = useState<Partial<AffiliateData>>({});

    useEffect(() => {
        const fetchAffiliateData = async () => {
            try {
                setLoading(true);
                setError(null);

                // Try to fetch affiliate profile, create if doesn't exist
                let affiliateRes;
                try {
                    affiliateRes = await authFetch.fetch('/affiliate/affiliates/me/');
                } catch (err: any) {
                    // If 404, try to create affiliate profile
                    if (err.status === 404) {
                        console.log('Affiliate profile not found, creating new one...');
                        affiliateRes = await authFetch.fetch('/affiliate/affiliates/me/', {
                            method: 'POST'
                        });
                    } else {
                        throw err;
                    }
                }
                setAffiliate(affiliateRes);

                // Fetch dashboard data
                try {
                    const dashboardRes = await authFetch.fetch('/affiliate/affiliates/dashboard/');
                    if (dashboardRes.recent_referrals) {
                        setReferrals(dashboardRes.recent_referrals);
                    }
                    if (dashboardRes.recent_commissions) {
                        setCommissions(dashboardRes.recent_commissions);
                    }
                } catch (dashErr) {
                    console.warn('Could not fetch dashboard data:', dashErr);
                    // Don't fail if dashboard data is unavailable
                }
            } catch (err) {
                console.error('Error fetching affiliate data:', err);
                setError(err instanceof Error ? err.message : 'Failed to load affiliate data');
                toast({
                    title: 'Error',
                    description: 'Failed to load affiliate data',
                    variant: 'destructive'
                });
            } finally {
                setLoading(false);
            }
        };

        if (user) {
            fetchAffiliateData();
        }
    }, [user]);

    const referralLink = useMemo(() => {
        if (!affiliate) return '';
        return `https://www.handy-pos.com/signup?ref=${affiliate.affiliate_code}`;
    }, [affiliate]);

    const handleCopyLink = () => {
        navigator.clipboard.writeText(referralLink);
        toast({
            title: "Link Copied!",
            description: "Your referral link has been copied to your clipboard.",
        });
    };

    const handleEditClick = () => {
        setEditData(affiliate);
        setIsEditing(true);
    };

    const handleCancel = () => {
        setIsEditing(false);
        setEditData({});
    };

    const handleSave = async () => {
        try {
            setIsSaving(true);
            const updateData = {
                company_name: editData.company_name || '',
                website: editData.website || '',
                phone: editData.phone || '',
                address: editData.address || '',
                bank_account: editData.bank_account || '',
                bank_name: editData.bank_name || '',
                account_holder: editData.account_holder || '',
                swift_code: editData.swift_code || '',
            };

            const response = await authFetch.fetch(`/affiliate/affiliates/${affiliate?.id}/`, {
                method: 'PATCH',
                body: JSON.stringify(updateData),
            });

            setAffiliate(response);
            setIsEditing(false);
            toast({
                title: 'Success',
                description: 'Profile updated successfully',
            });
        } catch (err) {
            console.error('Error saving profile:', err);
            toast({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to save profile',
                variant: 'destructive'
            });
        } finally {
            setIsSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-96">
                <div className="flex flex-col items-center gap-2">
                    <Loader2 className="h-8 w-8 animate-spin" />
                    <p className="text-muted-foreground">Loading affiliate data...</p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col gap-6">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">Affiliate Dashboard</h1>
                    <p className="text-muted-foreground">
                        Manage your referrals and track your earnings.
                    </p>
                </div>
                <Card className="border-red-200 bg-red-50">
                    <CardHeader>
                        <CardTitle className="text-red-900">Error Loading Data</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-red-800">{error}</p>
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (!affiliate) {
        return (
            <div className="flex flex-col gap-6">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">Affiliate Program</h1>
                    <p className="text-muted-foreground">
                        Join our affiliate program and start earning commissions.
                    </p>
                </div>
                <Card>
                    <CardHeader>
                        <CardTitle>Welcome to the Affiliate Program</CardTitle>
                        <CardDescription>
                            You haven't joined the affiliate program yet. Join now to start referring businesses and earning commissions.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="grid gap-4 md:grid-cols-3">
                            <div className="space-y-2">
                                <div className="flex items-center gap-2">
                                    <Users className="h-5 w-5 text-primary" />
                                    <h3 className="font-semibold">Refer Businesses</h3>
                                </div>
                                <p className="text-sm text-muted-foreground">
                                    Share your unique referral link with business owners and earn commissions when they sign up.
                                </p>
                            </div>
                            <div className="space-y-2">
                                <div className="flex items-center gap-2">
                                    <DollarSign className="h-5 w-5 text-primary" />
                                    <h3 className="font-semibold">Earn Commissions</h3>
                                </div>
                                <p className="text-sm text-muted-foreground">
                                    Earn recurring commissions from every business subscription you refer. The more you refer, the more you earn.
                                </p>
                            </div>
                            <div className="space-y-2">
                                <div className="flex items-center gap-2">
                                    <Wallet className="h-5 w-5 text-primary" />
                                    <h3 className="font-semibold">Get Paid</h3>
                                </div>
                                <p className="text-sm text-muted-foreground">
                                    Withdraw your earnings anytime. We support multiple payment methods for your convenience.
                                </p>
                            </div>
                        </div>

                        <div className="border-t pt-6">
                            <h3 className="font-semibold mb-4">How It Works</h3>
                            <ol className="space-y-3 text-sm">
                                <li className="flex gap-3">
                                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-semibold">1</span>
                                    <span>Join the affiliate program and get your unique referral code</span>
                                </li>
                                <li className="flex gap-3">
                                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-semibold">2</span>
                                    <span>Share your referral link with potential customers</span>
                                </li>
                                <li className="flex gap-3">
                                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-semibold">3</span>
                                    <span>Earn commissions when they subscribe to Handy POS</span>
                                </li>
                                <li className="flex gap-3">
                                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-semibold">4</span>
                                    <span>Withdraw your earnings to your preferred payment method</span>
                                </li>
                            </ol>
                        </div>

                        <Button size="lg" className="w-full">
                            Join the Affiliate Program
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    const conversionRate = affiliate.total_referred_businesses > 0 
        ? (affiliate.total_active_referrals / affiliate.total_referred_businesses) * 100 
        : 0;

    return (
        <div className="flex flex-col gap-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight">Affiliate Dashboard</h1>
                <p className="text-muted-foreground">
                    Manage your referrals and track your earnings.
                </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <KpiCard 
                    title="Total Referrals" 
                    value={affiliate.total_referred_businesses} 
                    icon={Users} 
                    description="Total businesses referred." 
                />
                <KpiCard 
                    title="Active Referrals" 
                    value={affiliate.total_active_referrals} 
                    icon={Percent} 
                    description="Businesses with active subscriptions." 
                />
                <KpiCard 
                    title="Total Earnings" 
                    value={formatCurrency(affiliate.total_commissions)} 
                    icon={DollarSign} 
                    description="Lifetime earnings from referrals." 
                />
                <KpiCard 
                    title="Total Paid" 
                    value={formatCurrency(affiliate.total_paid)} 
                    icon={Wallet} 
                    description="Amount already paid out." 
                />
            </div>

            <Tabs defaultValue="overview">
                <TabsList className="grid w-full grid-cols-4">
                    <TabsTrigger value="overview">Overview</TabsTrigger>
                    <TabsTrigger value="referrals">Referrals</TabsTrigger>
                    <TabsTrigger value="profile">Profile</TabsTrigger>
                    <TabsTrigger value="resources">Resources</TabsTrigger>
                </TabsList>
                <TabsContent value="overview">
                    <Card>
                        <CardHeader>
                            <CardTitle>Your Referral Link</CardTitle>
                            <CardDescription>Share this link to refer new businesses and earn commissions.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="flex w-full max-w-lg items-center space-x-2">
                                <Input value={referralLink} readOnly />
                                <Button onClick={handleCopyLink}>
                                    <Copy className="mr-2 h-4 w-4" /> Copy Link
                                </Button>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="mt-6">
                        <CardHeader>
                            <CardTitle>Recent Commissions</CardTitle>
                            <CardDescription>Your latest earned commissions from referred businesses.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {commissions.length > 0 ? (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Business</TableHead>
                                            <TableHead>Earned Date</TableHead>
                                            <TableHead className="text-right">Commission</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {commissions.map(commission => (
                                            <TableRow key={commission.id}>
                                                <TableCell className="font-medium">{commission.business_name}</TableCell>
                                                <TableCell>{format(new Date(commission.earned_date), 'PP')}</TableCell>
                                                <TableCell className="text-right font-semibold">{formatCurrency(commission.commission_amount)}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            ) : (
                                <p className="text-sm text-muted-foreground">No commissions yet. Start referring businesses to earn!</p>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>
                <TabsContent value="referrals">
                    <Card>
                        <CardHeader>
                            <CardTitle>Referral History</CardTitle>
                            <CardDescription>A complete log of all businesses you have referred.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {referrals.length > 0 ? (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Business Name</TableHead>
                                            <TableHead>Referral Date</TableHead>
                                            <TableHead>Status</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {referrals.map(ref => (
                                            <TableRow key={ref.id}>
                                                <TableCell className="font-medium">{ref.business_name}</TableCell>
                                                <TableCell>{format(new Date(ref.created_at), 'PP')}</TableCell>
                                                <TableCell>
                                                    <Badge variant="default">
                                                        {ref.status}
                                                    </Badge>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            ) : (
                                <p className="text-sm text-muted-foreground">No referrals yet. Share your link to get started!</p>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>
                <TabsContent value="profile">
                    <Card>
                        <CardHeader>
                            <CardTitle>Affiliate Profile</CardTitle>
                            <CardDescription>Your affiliate account information and settings.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div className="grid gap-6 md:grid-cols-2">
                                <div className="space-y-2">
                                    <label className="text-sm font-medium text-muted-foreground">Affiliate Code</label>
                                    <div className="flex items-center gap-2">
                                        <Input value={affiliate.affiliate_code} readOnly className="font-mono" />
                                        <Button 
                                            variant="outline" 
                                            size="icon"
                                            onClick={() => {
                                                navigator.clipboard.writeText(affiliate.affiliate_code);
                                                toast({ title: "Affiliate code copied!" });
                                            }}
                                        >
                                            <Copy className="h-4 w-4" />
                                        </Button>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-sm font-medium text-muted-foreground">Status</label>
                                    <div className="flex items-center gap-2">
                                        <Badge variant={affiliate.status === 'active' ? 'default' : 'secondary'}>
                                            {affiliate.status.charAt(0).toUpperCase() + affiliate.status.slice(1)}
                                        </Badge>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-sm font-medium text-muted-foreground">Joined Date</label>
                                    <p className="text-sm">{format(new Date(affiliate.joined_date), 'PPP')}</p>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-sm font-medium text-muted-foreground">Account Age</label>
                                    <p className="text-sm">
                                        {Math.floor((Date.now() - new Date(affiliate.joined_date).getTime()) / (1000 * 60 * 60 * 24))} days
                                    </p>
                                </div>
                            </div>

                            <div className="border-t pt-6">
                                <h3 className="font-semibold mb-4">Performance Summary</h3>
                                <div className="grid gap-4 md:grid-cols-2">
                                    <div className="rounded-lg border p-4">
                                        <p className="text-sm text-muted-foreground mb-1">Total Referrals</p>
                                        <p className="text-2xl font-bold">{affiliate.total_referred_businesses}</p>
                                    </div>
                                    <div className="rounded-lg border p-4">
                                        <p className="text-sm text-muted-foreground mb-1">Active Referrals</p>
                                        <p className="text-2xl font-bold">{affiliate.total_active_referrals}</p>
                                    </div>
                                    <div className="rounded-lg border p-4">
                                        <p className="text-sm text-muted-foreground mb-1">Total Commissions Earned</p>
                                        <p className="text-2xl font-bold">{formatCurrency(affiliate.total_commissions)}</p>
                                    </div>
                                    <div className="rounded-lg border p-4">
                                        <p className="text-sm text-muted-foreground mb-1">Total Paid Out</p>
                                        <p className="text-2xl font-bold">{formatCurrency(affiliate.total_paid)}</p>
                                    </div>
                                </div>
                            </div>

                            <div className="border-t pt-6">
                                <h3 className="font-semibold mb-4">Referral Link</h3>
                                <div className="flex w-full items-center space-x-2">
                                    <Input value={referralLink} readOnly />
                                    <Button onClick={handleCopyLink}>
                                        <Copy className="mr-2 h-4 w-4" /> Copy
                                    </Button>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="mt-6">
                        <CardHeader className="flex flex-row items-center justify-between">
                            <div>
                                <CardTitle>Business Information</CardTitle>
                                <CardDescription>Your company details for affiliate communications.</CardDescription>
                            </div>
                            {!isEditing && (
                                <Button variant="outline" onClick={handleEditClick}>
                                    Edit
                                </Button>
                            )}
                        </CardHeader>
                        <CardContent>
                            {isEditing ? (
                                <div className="space-y-4">
                                    <div className="grid gap-6 md:grid-cols-2">
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Company Name</label>
                                            <Input 
                                                value={editData.company_name || ''} 
                                                onChange={(e) => setEditData({...editData, company_name: e.target.value})}
                                                placeholder="Enter company name"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Website</label>
                                            <Input 
                                                value={editData.website || ''} 
                                                onChange={(e) => setEditData({...editData, website: e.target.value})}
                                                placeholder="https://example.com"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Phone</label>
                                            <Input 
                                                value={editData.phone || ''} 
                                                onChange={(e) => setEditData({...editData, phone: e.target.value})}
                                                placeholder="Enter phone number"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Address</label>
                                            <Input 
                                                value={editData.address || ''} 
                                                onChange={(e) => setEditData({...editData, address: e.target.value})}
                                                placeholder="Enter address"
                                            />
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="grid gap-6 md:grid-cols-2">
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-muted-foreground">Company Name</label>
                                        <p className="text-sm">{affiliate.company_name || 'Not provided'}</p>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-muted-foreground">Website</label>
                                        <p className="text-sm">
                                            {affiliate.website ? (
                                                <a href={affiliate.website} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                                    {affiliate.website}
                                                </a>
                                            ) : (
                                                'Not provided'
                                            )}
                                        </p>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-muted-foreground">Phone</label>
                                        <p className="text-sm">{affiliate.phone || 'Not provided'}</p>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-muted-foreground">Address</label>
                                        <p className="text-sm">{affiliate.address || 'Not provided'}</p>
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    <Card className="mt-6">
                        <CardHeader>
                            <CardTitle>Payment Information</CardTitle>
                            <CardDescription>Your banking details for commission payouts.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {isEditing ? (
                                <div className="space-y-4">
                                    <div className="grid gap-6 md:grid-cols-2">
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Bank Name</label>
                                            <Input 
                                                value={editData.bank_name || ''} 
                                                onChange={(e) => setEditData({...editData, bank_name: e.target.value})}
                                                placeholder="Enter bank name"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Account Holder</label>
                                            <Input 
                                                value={editData.account_holder || ''} 
                                                onChange={(e) => setEditData({...editData, account_holder: e.target.value})}
                                                placeholder="Enter account holder name"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Bank Account</label>
                                            <Input 
                                                value={editData.bank_account || ''} 
                                                onChange={(e) => setEditData({...editData, bank_account: e.target.value})}
                                                placeholder="Enter bank account number"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">SWIFT Code</label>
                                            <Input 
                                                value={editData.swift_code || ''} 
                                                onChange={(e) => setEditData({...editData, swift_code: e.target.value})}
                                                placeholder="Enter SWIFT code"
                                            />
                                        </div>
                                    </div>
                                    <div className="flex gap-2 pt-4">
                                        <Button onClick={handleSave} disabled={isSaving}>
                                            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                            Save Changes
                                        </Button>
                                        <Button variant="outline" onClick={handleCancel} disabled={isSaving}>
                                            Cancel
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <div className="grid gap-6 md:grid-cols-2">
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-muted-foreground">Bank Name</label>
                                        <p className="text-sm">{affiliate.bank_name || 'Not provided'}</p>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-muted-foreground">Account Holder</label>
                                        <p className="text-sm">{affiliate.account_holder || 'Not provided'}</p>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-muted-foreground">Bank Account</label>
                                        <p className="text-sm font-mono">{affiliate.bank_account ? `****${affiliate.bank_account.slice(-4)}` : 'Not provided'}</p>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium text-muted-foreground">SWIFT Code</label>
                                        <p className="text-sm">{affiliate.swift_code || 'Not provided'}</p>
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>
                <TabsContent value="resources">
                    <div className="grid gap-6">
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2"><ImageIcon /> Brand Assets</CardTitle>
                                <CardDescription>Download our official logo to use in your promotional materials.</CardDescription>
                            </CardHeader>
                            <CardContent className="flex flex-col sm:flex-row items-center gap-6">
                                <div className="rounded-lg border bg-muted p-6">
                                    <HandyPosLogo className="h-24 w-24" />
                                </div>
                                <div className="space-y-2">
                                    <h3 className="font-semibold">Handy POS Logo</h3>
                                    <p className="text-sm text-muted-foreground">Use this logo for any marketing material you create.</p>
                                    <Button><Download className="mr-2 h-4 w-4" /> Download Logo Pack</Button>
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2"><Megaphone /> Marketing Copy</CardTitle>
                                <CardDescription>Ready-to-use text for your social media posts, emails, or blog.</CardDescription>
                            </CardHeader>
                            <CardContent className="grid gap-4 sm:grid-cols-2">
                                <MarketingCopyCard
                                    title="Short Tweet / Post"
                                    content="Managing a small business? 💼 Handy POS is a game-changer for inventory and sales, and it works offline! Check it out. #POS #SmallBiz #Inventory"
                                />
                                <MarketingCopyCard
                                    title="Email/Blog Snippet"
                                    content="Looking for a point-of-sale system that doesn't quit when your internet does? I've been using Handy POS, and its offline-first approach is incredibly reliable for managing sales and inventory. It's designed for small businesses and is surprisingly powerful. Highly recommended for any retail or restaurant owner."
                                />
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2"><ImageIcon /> Promotional Banners</CardTitle>
                                <CardDescription>Use these banners on your website or in your marketing campaigns.</CardDescription>
                            </CardHeader>
                            <CardContent className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                                <div className="space-y-2">
                                    <p className="text-sm font-medium">Leaderboard (728x90)</p>
                                    <Image data-ai-hint="leaderboard ad banner" src="https://picsum.photos/seed/banner1/728/90" alt="Leaderboard banner" width={728} height={90} className="rounded-lg border" />
                                </div>
                                <div className="space-y-2">
                                    <p className="text-sm font-medium">Medium Rectangle (300x250)</p>
                                    <Image data-ai-hint="square ad banner" src="https://picsum.photos/seed/banner2/300/250" alt="Medium rectangle banner" width={300} height={250} className="rounded-lg border" />
                                </div>
                                <div className="space-y-2">
                                    <p className="text-sm font-medium">Skyscraper (160x600)</p>
                                    <Image data-ai-hint="vertical ad banner" src="https://picsum.photos/seed/banner3/160/600" alt="Skyscraper banner" width={160} height={600} className="rounded-lg border" />
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </TabsContent>
            </Tabs>
        </div>
    );
}
