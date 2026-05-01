'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
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
import { Loader2, Copy, Check, Link2, Unlink, ExternalLink, ChevronDown, ShieldCheck } from 'lucide-react';

interface OAuthStatus {
  provider: string;
  displayName: string;
  connected: boolean;
  expiresAt?: number;
}

interface PiOAuthButtonProps {
  onStatusChange?: () => void;
  hiddenProviderIds?: string[];
}

export function PiOAuthButton({ onStatusChange, hiddenProviderIds }: PiOAuthButtonProps) {
  const t = useTranslations('settings');
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<OAuthStatus | null>(null);
  const [flowId, setFlowId] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [instructions, setInstructions] = useState('');
  const [code, setCode] = useState('');
  const [providers, setProviders] = useState<OAuthStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const completedFlowRef = useRef<string | null>(null);

  // Load OAuth status on mount
  useEffect(() => {
    void loadStatus();
  }, []);

  const resetDialogState = () => {
    setCode('');
    setFlowId('');
    setAuthUrl('');
    setInstructions('');
    setSelectedProvider(null);
    setIsPolling(false);
    setPendingMessage(null);
    setIsFinalizing(false);
    completedFlowRef.current = null;
  };

  const handleConnected = async (provider: OAuthStatus, message?: string) => {
    setIsOpen(false);
    resetDialogState();
    setSuccessMessage(message || t('oauth.successConnected', { provider: provider.displayName }));
    await loadStatus();
    onStatusChange?.();
  };

  const completeOAuthFlow = async (currentFlowId: string, provider: OAuthStatus) => {
    if (completedFlowRef.current === currentFlowId) {
      return;
    }

    completedFlowRef.current = currentFlowId;
    setIsFinalizing(true);
    setPendingMessage(t('oauth.finishingProviderConnection'));
    setError(null);

    try {
      const response = await fetch('/api/oauth/pi/complete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flowId: currentFlowId,
          provider: provider.provider,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || t('oauth.errors.completeFlow'));
      }

      await handleConnected(provider, data.message);
    } catch (err) {
      completedFlowRef.current = null;
      setError(err instanceof Error ? err.message : t('oauth.errors.unknown'));
    } finally {
      setIsFinalizing(false);
    }
  };

  // Poll for auth URL and flow completion while dialog is open
  useEffect(() => {
    if (!flowId || !isOpen || !selectedProvider) return;

    let authUrlResolved = Boolean(authUrl);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const pollFlow = async () => {
      try {
        const response = await fetch(`/api/oauth/pi/poll?flowId=${flowId}`, {
          credentials: 'include',
        });
        
        if (!response.ok) return;
        
        const data = await response.json();
        
        if (data.success) {
          if (data.authUrl) {
            setAuthUrl(data.authUrl);
            setInstructions(data.instructions || '');
            setIsPolling(false);
            authUrlResolved = true;
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            

          }

          if (data.status === 'completed' && data.hasCredentials) {
            await completeOAuthFlow(flowId, selectedProvider);
            return;
          }
          
          if (data.status === 'failed' || data.error) {
            setError(data.error || t('oauth.errors.flowFailed'));
            setIsPolling(false);
            setPendingMessage(null);
          }
        }
      } catch (err) {
        console.error('Poll error:', err);
      }
    };

    const pollInterval = setInterval(() => {
      void pollFlow();
    }, 1000);

    void pollFlow();

    // Stop polling after 60 seconds
    if (!authUrlResolved) {
      timeoutId = setTimeout(() => {
        if (!authUrlResolved) {
          setError(t('oauth.errors.timeoutWaitingForUrl'));
          setIsPolling(false);
        }
      }, 60000);
    }

    return () => {
      clearInterval(pollInterval);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- completeOAuthFlow is a plain function; t is stable
  }, [flowId, isOpen, selectedProvider, authUrl]);

  useEffect(() => {
    if (!isOpen && flowId) {
      resetDialogState();
    }
  }, [isOpen, flowId]);

  // Clear success message after 5 seconds
  useEffect(() => {
    if (successMessage) {
      const timeout = setTimeout(() => {
        setSuccessMessage(null);
      }, 5000);
      return () => clearTimeout(timeout);
    }
  }, [successMessage]);

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
      setError(t('oauth.errors.selectProvider'));
      return;
    }

    setIsLoading(true);
    setIsPolling(true);
    setError(null);
    setSuccessMessage(null);
    setPendingMessage(null);
    setAuthUrl('');
    setInstructions('');
    setCode('');
    setFlowId('');
    completedFlowRef.current = null;

    try {
      const response = await fetch('/api/oauth/pi/initiate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: selectedProvider.provider }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || t('oauth.errors.initiate'));
      }

      setFlowId(data.flowId);
      setIsOpen(true);
      
      // If auth URL is already available, use it
      if (data.authUrl) {
        setAuthUrl(data.authUrl);
        setInstructions(data.instructions || '');
        setIsPolling(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('oauth.errors.unknown'));
      setIsPolling(false);
    } finally {
      setIsLoading(false);
    }
  };

  const exchangeCode = async () => {
    if (!code.trim()) {
      setError(t('oauth.errors.enterCode'));
      return;
    }

    if (!flowId || !selectedProvider) {
      setError(t('oauth.errors.missingFlowInfo'));
      return;
    }

    setIsLoading(true);
    setError(null);
    setPendingMessage(null);

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
        throw new Error(data.error || t('oauth.errors.exchangeCode'));
      }

      if (data.pending) {
        setPendingMessage(data.message || t('oauth.pendingDefault'));
        setIsPolling(true);
        return;
      }

      await handleConnected(selectedProvider, data.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('oauth.errors.unknown'));
    } finally {
      setIsLoading(false);
    }
  };

  const disconnect = async (provider: OAuthStatus) => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/oauth/pi/disconnect', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: provider.provider }),
      });

      if (response.ok) {
        setSuccessMessage(t('oauth.disconnected', { provider: provider.displayName }));
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

  const hiddenSet = new Set(hiddenProviderIds ?? []);
  const visibleProviders = providers.filter(p => !hiddenSet.has(p.provider));
  const availableProviders = visibleProviders.filter(p => !p.connected);
  const connectedProviders = visibleProviders.filter(p => p.connected);

  return (
    <div className="space-y-4">
      {/* Success Message */}
      {successMessage && (
        <div className="rounded-md bg-green-50 border border-green-200 p-3 flex items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-300">
          <ShieldCheck className="h-5 w-5 text-green-600" />
          <span className="text-sm font-medium text-green-800">{successMessage}</span>
        </div>
      )}

      {/* Connected Accounts Section */}
      {connectedProviders.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-foreground">{t('oauth.sections.connectedAccounts')}</h4>
            <span className="text-xs text-muted-foreground bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
              {t('oauth.sections.activeCount', { count: connectedProviders.length })}
            </span>
          </div>
          
          <div className="space-y-2">
            {connectedProviders.map((provider) => (
              <div
                key={provider.provider}
                className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50/50 p-4 shadow-sm"
              >
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-green-100">
                    <Check className="h-4 w-4 text-green-600" />
                  </div>
                  <div>
                    <span className="text-sm font-semibold text-foreground">{provider.displayName}</span>
                    <p className="text-xs text-green-600">{t('oauth.sections.connectedAndReady')}</p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void disconnect(provider)}
                  disabled={isLoading}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  {isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Unlink className="h-4 w-4 mr-1" />
                  )}
                  {t('oauth.sections.disconnect')}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Divider */}
      {connectedProviders.length > 0 && availableProviders.length > 0 && (
        <div className="relative py-2">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-background px-2 text-xs text-muted-foreground">{t('oauth.sections.addAnotherAccount')}</span>
          </div>
        </div>
      )}

      {/* Connect New Account Section */}
      {availableProviders.length > 0 ? (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-foreground">{t('oauth.sections.connectAccount')}</h4>
          <div className="flex gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button 
                  variant="outline" 
                  className="flex-1 justify-between h-10"
                  disabled={isLoading}
                  data-testid="pi-oauth-provider-select"
                >
                  {selectedProvider ? (
                    <span className="font-medium">{selectedProvider.displayName}</span>
                  ) : (
                    <span className="text-muted-foreground">{t('oauth.sections.selectProvider')}</span>
                  )}
                  <ChevronDown className="h-4 w-4 ml-2 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-[300px]" align="start">
                {availableProviders.map((provider) => (
                  <DropdownMenuItem 
                    key={provider.provider}
                    onClick={() => setSelectedProvider(provider)}
                    className="cursor-pointer"
                  >
                    {provider.displayName}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
              <Button
                onClick={() => void initiateAuth()}
                disabled={isLoading || !selectedProvider}
                className="h-10"
                data-testid="pi-oauth-connect-button"
              >
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="mr-2 h-4 w-4" />
              )}
              {t('oauth.sections.connect')}
            </Button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      ) : connectedProviders.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-4">
          {t('oauth.sections.noProvidersAvailable')}
        </div>
      ) : null}

      {/* OAuth Dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>{t('oauth.dialog.title')}</DialogTitle>
            <DialogDescription>
              {t('oauth.dialog.description')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Waiting for URL */}
            {isPolling && !authUrl && (
              <div className="flex flex-col items-center gap-3 py-8">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <div className="text-center">
                  <p className="text-sm font-medium">{t('oauth.dialog.waitingForUrlTitle')}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('oauth.dialog.waitingForUrlDescription')}
                  </p>
                </div>
              </div>
            )}

            {/* Auth URL */}
            {authUrl && (
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('oauth.dialog.step1Label')}</label>
                <p className="text-xs text-muted-foreground">
                  {t('oauth.dialog.step1Description')}
                </p>
                <div className="flex gap-2">
                  <Input
                    value={authUrl}
                    readOnly
                    className="font-mono text-xs flex-1"
                    data-testid="pi-oauth-auth-url"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => void copyAuthUrl()}
                    title={t('oauth.dialog.copyUrl')}
                  >
                    {copied ? (
                      <Check className="h-4 w-4 text-green-600" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={openAuthUrl}
                    title={t('oauth.dialog.openInNewTab')}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* Instructions */}
            {instructions && (
              <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm">
                <p className="font-medium text-blue-900 mb-2">{t('oauth.dialog.instructions')}</p>
                <div className="text-blue-800 whitespace-pre-line">{instructions}</div>
              </div>
            )}

            {/* Code Input - Always show when authUrl is available */}
            {authUrl && (
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('oauth.dialog.step2Label')}</label>
                <p className="text-xs text-muted-foreground">
                  {t('oauth.dialog.step2Description')}
                </p>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={t('oauth.dialog.codePlaceholder')}
                  className="font-mono text-sm"
                  data-testid="pi-oauth-code-input"
                />
              </div>
            )}

            {error && (
              <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive">
                {error}
              </div>
            )}

            {pendingMessage && (
              <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-sm text-blue-800">
                {pendingMessage}
              </div>
            )}

            <Button
              onClick={() => void exchangeCode()}
              disabled={isLoading || isFinalizing || !authUrl || !code.trim()}
              className="w-full"
              data-testid="pi-oauth-complete-button"
            >
              {isLoading || isFinalizing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="mr-2 h-4 w-4" />
              )}
              {t('oauth.dialog.completeConnection')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
