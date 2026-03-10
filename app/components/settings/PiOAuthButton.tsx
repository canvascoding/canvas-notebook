'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Loader2, Copy, Check, Link2, Unlink, ExternalLink, ChevronDown } from 'lucide-react';

interface OAuthStatus {
  provider: string;
  displayName: string;
  connected: boolean;
  expiresAt?: number;
}

interface PiOAuthButtonProps {
  onStatusChange?: () => void;
}

export function PiOAuthButton({ onStatusChange }: PiOAuthButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<OAuthStatus | null>(null);
  const [flowId, setFlowId] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [instructions, setInstructions] = useState('');
  const [requiresCode, setRequiresCode] = useState(false);
  const [code, setCode] = useState('');
  const [providers, setProviders] = useState<OAuthStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pollStatus, setPollStatus] = useState('waiting');

  // Load OAuth status on mount
  useEffect(() => {
    void loadStatus();
  }, []);

  // Poll for auth URL when flow is active
  useEffect(() => {
    if (!flowId || !isOpen || authUrl) return;

    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/oauth/pi/poll?flowId=${flowId}`, {
          credentials: 'include',
        });
        
        if (!response.ok) return;
        
        const data = await response.json();
        
        if (data.success) {
          setPollStatus(data.status);
          
          if (data.authUrl) {
            setAuthUrl(data.authUrl);
            setInstructions(data.instructions || '');
            setRequiresCode(true);
            clearInterval(pollInterval);
            
            // Auto-open the auth URL
            window.open(data.authUrl, '_blank');
          }
          
          if (data.status === 'failed' || data.error) {
            setError(data.error || 'OAuth flow failed');
            setIsPolling(false);
            clearInterval(pollInterval);
          }
        }
      } catch (err) {
        console.error('Poll error:', err);
      }
    }, 1000);

    // Stop polling after 60 seconds
    const timeout = setTimeout(() => {
      clearInterval(pollInterval);
      if (!authUrl) {
        setError('Timeout waiting for authorization URL');
        setIsPolling(false);
      }
    }, 60000);

    return () => {
      clearInterval(pollInterval);
      clearTimeout(timeout);
    };
  }, [flowId, isOpen, authUrl]);

  const loadStatus = async () => {
    try {
      const response = await fetch('/api/oauth/pi/status', {
        credentials: 'include',
      });
      const data = await response.json();
      
      if (data.success && data.providers) {
        setProviders(data.providers);
      }
    } catch (err) {
      console.error('Failed to load OAuth status:', err);
    }
  };

  const initiateAuth = async () => {
    if (!selectedProvider) {
      setError('Please select a provider');
      return;
    }

    setIsLoading(true);
    setIsPolling(true);
    setError(null);
    setAuthUrl('');
    setInstructions('');
    setRequiresCode(false);
    setCode('');
    setFlowId('');
    setPollStatus('waiting');

    try {
      const response = await fetch('/api/oauth/pi/initiate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: selectedProvider.provider }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to initiate OAuth');
      }

      setFlowId(data.flowId);
      setIsOpen(true);
      
      // If auth URL is already available, use it
      if (data.authUrl) {
        setAuthUrl(data.authUrl);
        setInstructions(data.instructions || '');
        setRequiresCode(true);
        setIsPolling(false);
        window.open(data.authUrl, '_blank');
      }
      // Otherwise, polling will handle it
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setIsPolling(false);
    } finally {
      setIsLoading(false);
    }
  };

  const exchangeCode = async () => {
    if (requiresCode && !code.trim()) {
      setError('Please enter the authorization code');
      return;
    }

    if (!flowId || !selectedProvider) {
      setError('Missing flow information');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/oauth/pi/exchange', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          flowId,
          provider: selectedProvider.provider,
          code: code.trim(),
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to exchange code');
      }

      setIsOpen(false);
      setCode('');
      setFlowId('');
      setAuthUrl('');
      setSelectedProvider(null);
      await loadStatus();
      onStatusChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  const disconnect = async (provider: string) => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/oauth/pi/disconnect', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });

      if (response.ok) {
        await loadStatus();
        onStatusChange?.();
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

  const availableProviders = providers.filter(p => !p.connected);
  const connectedProviders = providers.filter(p => p.connected);

  return (
    <div className="space-y-4">
      {/* Connected providers */}
      {connectedProviders.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Connected Accounts</h4>
          {connectedProviders.map((provider) => (
            <div
              key={provider.provider}
              className="flex items-center justify-between rounded border border-primary/30 bg-primary/5 p-3"
            >
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">{provider.displayName}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void disconnect(provider.provider)}
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
          ))}
        </div>
      )}

      {/* Connect new provider */}
      {availableProviders.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Connect Account</h4>
          <div className="flex gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button 
                  variant="outline" 
                  className="flex-1 justify-between"
                  disabled={isLoading}
                >
                  {selectedProvider ? selectedProvider.displayName : 'Select provider...'}
                  <ChevronDown className="h-4 w-4 ml-2" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-[300px]">
                {availableProviders.map((provider) => (
                  <DropdownMenuItem 
                    key={provider.provider}
                    onClick={() => setSelectedProvider(provider)}
                  >
                    {provider.displayName}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              onClick={() => void initiateAuth()}
              disabled={isLoading || !selectedProvider}
            >
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="mr-2 h-4 w-4" />
              )}
              Connect
            </Button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}

      {/* OAuth Dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Connect OAuth Account</DialogTitle>
            <DialogDescription>
              Complete the authentication to connect your account.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Waiting for URL */}
            {isPolling && !authUrl && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Waiting for authorization URL...</span>
              </div>
            )}

            {/* Auth URL */}
            {authUrl && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Step 1: Authorization URL</label>
                <p className="text-xs text-muted-foreground">
                  This URL has been opened in a new tab. If it didn&apos;t open automatically, copy and paste it into your browser.
                </p>
                <div className="flex gap-2">
                  <Input
                    value={authUrl}
                    readOnly
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => void copyAuthUrl()}
                    title="Copy URL"
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
                    title="Open in new tab"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* Instructions */}
            {instructions && (
              <div className="rounded bg-muted/50 p-3 text-sm text-muted-foreground space-y-1">
                <p><strong>Instructions:</strong></p>
                <div className="whitespace-pre-line">{instructions}</div>
              </div>
            )}

            {/* Code Input */}
            {requiresCode && authUrl && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Step 2: Enter authorization code</label>
                <p className="text-xs text-muted-foreground">
                  After completing authentication in the browser, paste the authorization code or the redirect URL here.
                </p>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Paste authorization code or callback URL here..."
                  className="font-mono text-xs"
                />
              </div>
            )}

            {error && (
              <div className="rounded bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <Button
              onClick={() => void exchangeCode()}
              disabled={isLoading || !authUrl || (requiresCode && !code.trim())}
              className="w-full"
            >
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="mr-2 h-4 w-4" />
              )}
              Complete Connection
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
