'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Loader2, AlertCircle, Eye, EyeOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth-fetch';
import { db } from '@/lib/db';

const signupSchema = z
  .object({
    firstName: z.string().min(2, 'First name must be at least 2 characters.'),
    lastName: z.string().min(2, 'Last name must be at least 2 characters.'),
    email: z.string().email('Please enter a valid email.').optional().or(z.literal('')),
    phone: z.string().min(10, 'Please enter a valid phone number.').optional().or(z.literal('')),
    password: z
      .string()
      .min(6, 'Password must be at least 6 characters.'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match.",
    path: ['confirmPassword'],
  })
  .refine((data) => data.email || data.phone, {
    message: 'Please provide either an email or phone number.',
    path: ['email'],
  });

type SignupFormValues = z.infer<typeof signupSchema>;

export default function SignupPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [showReferralConfirm, setShowReferralConfirm] = useState(false);
  const [pendingData, setPendingData] = useState<any>(null);
  const [isSigningUp, setIsSigningUp] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const router = useRouter();
  const { toast } = useToast();
  const { login, selectBusiness, user } = useAuth();

  // Redirect authenticated users away from signup (but not during signup process)
  useEffect(() => {
    if (user && !isSigningUp) {
      router.push('/dashboard');
    }
  }, [user, router, isSigningUp]);
  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
  } = useForm<SignupFormValues>({
    resolver: zodResolver(signupSchema),
  });

  const emailValue = watch('email');
  const phoneValue = watch('phone');

  const completeSignup = async (businessResponse: any, data: SignupFormValues) => {
    try {
      // Determine if registering with email or phone
      const identifier = data.email || data.phone;

      // Check referral status
      if (businessResponse.referral_status) {
        if (businessResponse.referral_status.valid && businessResponse.referral_status.message) {
          // Valid referral code - show success message
          toast({
            title: 'Referral Applied',
            description: businessResponse.referral_status.message,
          });
        }
      }

      // Store business info in localStorage via context
      const businessData = {
        id: businessResponse.id,
        name: businessResponse.name,
        type: businessResponse.business_type,
        selectedAt: new Date().toISOString(),
      };
      selectBusiness(businessData);

      // Store business ID in localStorage for sync queue
      localStorage.setItem('handypos-business-id', businessResponse.id);

      // Sync business to local DB
      await db.business.put({
        id: businessResponse.id,
        name: businessResponse.name,
        type: businessResponse.business_type,
        currency: businessResponse.settings?.currency || 'USD',
        email: businessResponse.email,
        phone: businessResponse.phone,
        address: businessResponse.address,
        website: businessResponse.website,
      });

      // Store branches and set current branch
      if (businessResponse.branches && businessResponse.branches.length > 0) {
        const mainBranch = businessResponse.branches[0];
        localStorage.setItem('handypos-active-branch', mainBranch.id);
        localStorage.setItem('handypos-current-branch-id', mainBranch.id);
        
        for (const branch of businessResponse.branches) {
          localStorage.setItem(
            `handypos-branch-${branch.id}`,
            JSON.stringify(branch)
          );
        }
      }

      // Create user session
      const resolvedUid = user?.uid || identifier || '';
      const resolvedEmail = user?.email || data.email || undefined;
      const resolvedPhone = user?.phone || data.phone || undefined;
      const resolvedDisplayName = user?.displayName || `${data.firstName} ${data.lastName}`.trim();
      const userPayload = {
        uid: resolvedUid,
        email: resolvedEmail,
        phone: resolvedPhone,
        displayName: resolvedDisplayName,
        role: 'Admin' as const,
        businessId: businessResponse.id,
      };

      login(userPayload);

      toast({
        title: 'Account Created',
        description: `Welcome ${data.firstName}! Your account and business have been created.`,
      });

      // Redirect to subscription page
      router.push('/subscription');
    } catch (error: any) {
      console.error('Signup completion error:', error);
      const errorMsg = error.message || 'An unexpected error occurred.';
      setError(errorMsg);
      toast({
        variant: 'destructive',
        title: 'Signup Failed',
        description: errorMsg,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const onSubmit = async (data: SignupFormValues) => {
    setIsLoading(true);
    setIsSigningUp(true);
    setError('');
    try {
      // Register user via backend using the register method which handles tokens
      const identifier = data.email || data.phone || '';
      const registerResponse = await authFetch.register(
        identifier,
        data.password,
        data.firstName,
        data.lastName
      );

      if (!registerResponse.access || !registerResponse.refresh) {
        throw new Error('Failed to get authentication tokens');
      }

      const responseUser = registerResponse?.user ?? null;
      const responseUserId = responseUser?.id ?? responseUser?.uid ?? responseUser?.user_id;
      const resolvedEmail = responseUser?.email || data.email || undefined;
      const resolvedPhone = responseUser?.phone || data.phone || undefined;
      const nameFromProfile = `${responseUser?.first_name || ''} ${responseUser?.last_name || ''}`.trim();
      const displayName = nameFromProfile || `${data.firstName} ${data.lastName}`.trim();
      // Create user session
      const user = {
        uid: responseUserId || identifier,
        email: resolvedEmail,
        phone: resolvedPhone,
        displayName,
        role: 'Admin' as const,
      };

      login(user);

      toast({
        title: 'Account Created',
        description: `Welcome ${data.firstName}! Your account has been created.`,
      });

      // Redirect to setup wizard to create business
      router.push('/setup');
    } catch (error: any) {
      console.error('Signup error:', error);
      
      // Parse backend validation errors
      let errorMsg = error.message || 'An unexpected error occurred.';
      
      // Check if error is from backend validation
      if (error.message && error.message.includes('HTTP 400')) {
        // Try to extract detailed error from response
        try {
          // The error message might contain JSON from the response
          const match = error.message.match(/HTTP 400/);
          if (match) {
            errorMsg = 'Registration failed. Please check your information and try again.';
          }
        } catch (e) {
          // Fallback to generic message
        }
      }
      
      setError(errorMsg);
      toast({
        variant: 'destructive',
        title: 'Signup Failed',
        description: errorMsg,
      });
      setIsLoading(false);
      setIsSigningUp(false);
    }
  };

  const handleContinueAnyway = async () => {
    setShowReferralConfirm(false);
    if (pendingData) {
      await completeSignup(pendingData.businessResponse, pendingData.data);
      setPendingData(null);
    }
  };

  const handleGoBack = () => {
    setShowReferralConfirm(false);
    setPendingData(null);
  };

  return (
    <Card className="w-full max-w-sm">
      <form onSubmit={handleSubmit(onSubmit)}>
        <CardHeader>
          <CardTitle className="text-xl">Sign Up</CardTitle>
          <CardDescription>
            Create an account with email or phone number
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="firstName">First Name</Label>
              <Input
                id="firstName"
                type="text"
                placeholder="John"
                {...register('firstName')}
                disabled={isLoading}
              />
              {errors.firstName && (
                <p className="text-sm text-destructive">{errors.firstName.message}</p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="lastName">Last Name</Label>
              <Input
                id="lastName"
                type="text"
                placeholder="Doe"
                {...register('lastName')}
                disabled={isLoading}
              />
              {errors.lastName && (
                <p className="text-sm text-destructive">{errors.lastName.message}</p>
              )}
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="email">Email (Optional)</Label>
            <Input
              id="email"
              type="email"
              placeholder="john@example.com"
              {...register('email')}
              disabled={isLoading}
            />
            {errors.email && (
              <p className="text-sm text-destructive">{errors.email.message}</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="phone">Phone Number (Optional)</Label>
            <Input
              id="phone"
              type="tel"
              placeholder="+1 (555) 123-4567"
              {...register('phone')}
              disabled={isLoading}
            />
            {errors.phone && (
              <p className="text-sm text-destructive">{errors.phone.message}</p>
            )}
          </div>

          <div className="text-xs text-muted-foreground text-center">
            {emailValue && phoneValue ? (
              <p>✓ Both email and phone provided</p>
            ) : emailValue ? (
              <p>✓ Registering with email</p>
            ) : phoneValue ? (
              <p>✓ Registering with phone</p>
            ) : (
              <p>⚠ Please provide email or phone</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••"
                {...register('password')}
                disabled={isLoading}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                disabled={isLoading}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            {errors.password && (
              <p className="text-sm text-destructive">
                {errors.password.message}
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirmPassword">Confirm Password</Label>
            <div className="relative">
              <Input
                id="confirmPassword"
                type={showConfirmPassword ? 'text' : 'password'}
                placeholder="••••••"
                {...register('confirmPassword')}
                disabled={isLoading}
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                disabled={isLoading}
                aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
              >
                {showConfirmPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            {errors.confirmPassword && (
              <p className="text-sm text-destructive">
                {errors.confirmPassword.message}
              </p>
            )}
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-4">
          <Button type="submit" className="w-full" disabled={isLoading || (!emailValue && !phoneValue)}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create an account
          </Button>
          <div className="text-center text-sm">
            Already have an account?{' '}
            <Link href="/login" className="underline">
              Sign in
            </Link>
          </div>
          <Link
            href="/documentation"
            className="text-center text-xs font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Read the documentation
          </Link>
        </CardFooter>
      </form>

      <AlertDialog open={showReferralConfirm} onOpenChange={setShowReferralConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Invalid Referral Code</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingData?.businessResponse?.referral_status?.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogDescription className="text-sm text-muted-foreground mt-2">
            Would you like to continue without a referral code, or go back and enter a valid code?
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleGoBack}>
              Go Back
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleContinueAnyway}>
              Continue Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
