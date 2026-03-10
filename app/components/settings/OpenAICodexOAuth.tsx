'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, Copy, Check, Link2, Unlink, ExternalLink } from 'lucide-react';

interface OAuthStatus {
  connected: boolean;
  email?: string;
  expiresAt?: number;
}

interface OAuthInitiateResponse {
  success: boolean;
  authUrl?: string;
  message?: string;
  error?: string;
}

interface OAuthVerifyResponse {
  success: boolean;
  email?: string;
  message?: string;
  error?: string;
}

interface OpenAICodexOAuthProps {
  providerId: string;
}

export function OpenAICodexOAuth({ providerId }: OpenAICodexOAuthProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [authUrl, setAuthUrl] = useState('');
  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [step, setStep] = useState<'initiate' | 'verify'>('initiate');

  // Load status on mount
  useEffect(() => {
    if (providerId === 'openai-codex') {
      void checkStatus();
    }
  }, [providerId]);

  const checkStatus = async () => {
    try {
      const response = await fetch('/api/oauth/openai-codex/status', {
        credentials: 'include',
      });
      const data = (await response.json()) as OAuthStatus;
      setStatus(data);
    } catch (err) {
      console.error('Failed to check OAuth status:', err);
    }
  };

  const initiateAuth = async () => {
    setIsLoading(true);
    setError(null);
    setAuthUrl('');
    setStep('initiate');

    try {
      const response = await fetch('/api/oauth/openai-codex/initiate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = (await response.json()) as OAuthInitiateResponse;

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to initiate OAuth');
      }

      setAuthUrl(data.authUrl || '');
      setIsOpen(true);
      setStep('initiate');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  const verifyConnection = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/oauth/openai-codex/exchange', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}), // No callback URL needed - we read from codex config
      });

      const data = (await response.json()) as OAuthVerifyResponse;

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to verify connection');
      }

      setStatus({
        connected: true,
        email: data.email,
      });
      setIsOpen(false);
      setStep('initiate');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  const disconnect = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/oauth/openai-codex/disconnect', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });

      if (response.ok) {
        setStatus({ connected: false });
      }
    } catch (err) {
      console.error('Failed to disconnect:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const copyAuthUrl = async () => {
    if (!authUrl) return;
    await navigator.clipboard.writeText(authUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const openAuthUrl = () => {
    if (authUrl) {
      window.open(authUrl, '_blank');
    }
  };

  // Only show for openai-codex provider
  if (providerId !== 'openai-codex') {
    return null;
  }

  // Show connected status
  if (status?.connected) {
    return (
      <div className="rounded border border-primary/30 bg-primary/5 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">Connected</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void disconnect()}
            disabled={isLoading}
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Unlink className="h-4 w-4 mr-1" />
            )}
            Disconnect
          </Button>
        </div>
        {status.email && (
          <p className="text-xs text-muted-foreground">Account: {status.email}</p>
        )}
      </div>
    );
  }

  return (
    <>
      <div data-testid="openai-codex-oauth-button" className="space-y-2">
        <Button
          onClick={() => void initiateAuth()}
          disabled={isLoading}
          variant="outline"
          className="w-full"
        >
          {isLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Link2 className="mr-2 h-4 w-4" />
          )}
          Connect OpenAI Account
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Connect OpenAI Codex</DialogTitle>
            <DialogDescription>
              Authenticate using the official Codex CLI
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {step === 'initiate' ? (
              <>
                {/* Step 1: Auth URL */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Step 1: Open this URL in your browser</label>
                  <div className="flex gap-2">
                    <Input
                      value={authUrl}
                      readOnly
                      className="font-mono text-xs"
                      placeholder="Generating auth URL..."
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => void copyAuthUrl()}
                      disabled={!authUrl}
                    >
                      {copied ? (
                        <Check className="h-4 w-4 text-primary" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={openAuthUrl}
                      disabled={!authUrl}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="rounded bg-muted/50 p-3 text-sm text-muted-foreground space-y-2">
                  <p><strong>Instructions:</strong></p>
                  <ol className="list-decimal list-inside space-y-1">
                    <li>Copy or open the URL above</li>
                    <li>Complete the login in your browser</li>
                    <li>After successful login, the token will be stored locally by Codex CLI</li>
                    <li>Return here and click "Verify Connection"</li>
                  </ol>
                </div>

                <Button
                  onClick={() => setStep('verify')}
                  className="w-full"
                  variant="outline"
                >
                  I&apos;ve completed the login → Verify Connection
                </Button>
              </>
            ) : (
              <>
                {/* Step 2: Verify */}
                <div className="space-y-4">
                  <div className="rounded bg-muted/50 p-3 text-sm text-muted-foreground">
                    <p>Click below to verify that the Codex CLI has successfully authenticated and copy the token to Canvas Notebook.</p>
                  </div>

                  <Button
                    onClick={() => void verifyConnection()}
                    disabled={isLoading}
                    className="w-full"
                  >
                    {isLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="mr-2 h-4 w-4" />
                    )}
                    Verify Connection
                  </Button>

                  <Button
                    onClick={() => setStep('initiate')}
                    variant="ghost"
                    className="w-full"
                  >
                    ← Back to Auth URL
                  </Button>
                </div>
              </>
            )}

            {error && (
              <div className="rounded bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
