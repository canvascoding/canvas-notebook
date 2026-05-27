'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, KeyRound, Loader2, Mail, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';

type LicenseStatus = {
  licensed: boolean;
  plan: string;
  instanceId: string;
  expiresAt: string | null;
  error?: string;
};

function licenseErrorMessage(error?: string) {
  switch (error) {
    case 'missing_public_key':
    case 'public_key_unavailable':
      return 'License verification is unavailable. Configure the license public key or check the Control Plane connection.';
    case 'control_plane_unreachable':
      return 'Could not reach the license server. Check the Control Plane URL or network connection.';
    case 'untrusted_public_key':
      return 'The license server returned an untrusted public key. Check CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS.';
    case 'license_expired':
      return 'License expired. Please renew or activate a new license.';
    default:
      return error;
  }
}

export function LicenseActivationPanel({ defaultEmail }: { defaultEmail: string }) {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [email, setEmail] = useState(defaultEmail);
  const [key, setKey] = useState(searchParams.get('key') || '');
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [activating, setActivating] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetch('/api/license/status', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload) => {
        if (mounted) setStatus(payload);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function requestLicense() {
    setRegistering(true);
    try {
      const response = await fetch('/api/license/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'License request failed');
      }
      toast.success(`License email sent to ${email}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'License request failed');
    } finally {
      setRegistering(false);
    }
  }

  async function activateLicense() {
    setActivating(true);
    try {
      const response = await fetch('/api/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'License activation failed');
      }
      setStatus(payload);
      toast.success('License activated');
      window.location.href = '/';
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'License activation failed');
    } finally {
      setActivating(false);
    }
  }

  const isLicensed = Boolean(status?.licensed);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                {isLicensed ? <CheckCircle2 className="h-5 w-5" /> : <ShieldAlert className="h-5 w-5" />}
                License
              </CardTitle>
              <CardDescription>
                {isLicensed
                  ? 'This Canvas Notebook instance is verified.'
                  : 'Verify this self-hosted instance before using the app.'}
              </CardDescription>
            </div>
            <Badge variant={isLicensed ? 'default' : 'secondary'}>{loading ? 'Loading' : status?.plan || 'unregistered'}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 text-sm">
            <div className="flex items-center justify-between gap-3 border border-border px-3 py-2">
              <span className="text-muted-foreground">Instance ID</span>
              <span className="truncate font-mono text-xs">{status?.instanceId || '...'}</span>
            </div>
            {status?.expiresAt && (
              <div className="flex items-center justify-between gap-3 border border-border px-3 py-2">
                <span className="text-muted-foreground">Expires</span>
                <span>{new Date(status.expiresAt).toLocaleString()}</span>
              </div>
            )}
          </div>

          {!isLicensed && (
            <>
              <div className="space-y-2">
                <Label htmlFor="license-email">Email</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input id="license-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
                  <Button onClick={requestLicense} disabled={registering || !email.trim()} className="gap-2">
                    {registering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                    Send key
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="license-key">Activation key</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input id="license-key" value={key} onChange={(event) => setKey(event.target.value)} />
                  <Button onClick={activateLicense} disabled={activating || !key.trim()} className="gap-2">
                    {activating ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                    Activate
                  </Button>
                </div>
              </div>

              {status?.error && (
                <p className="text-sm text-destructive">
                  {licenseErrorMessage(status.error)}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
