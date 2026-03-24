'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authClient } from '@/app/lib/auth-client';
import { toast } from 'sonner';
import Image from 'next/image';

export default function LoginClient() {
  const t = useTranslations('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const { error } = await authClient.signIn.email({
        email,
        password,
      });

      if (error) {
        toast.error(error.message || t('loginFailed'));
      } else {
        toast.success(t('loginSuccessful'));
        window.location.href = '/';
      }
    } catch (err) {
      toast.error(t('unexpectedError'));
      console.error('Login error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md border border-border bg-card p-8 shadow-sm">
        <div className="flex items-center justify-center mb-8">
          <Image src="/logo.jpg" alt={t('logoAlt')} width={48} height={48} className="mr-3 border border-border" />
          <h1 className="text-3xl font-bold text-foreground">{t('title')}</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-foreground/90 mb-2">
              {t('email')}
            </label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('emailPlaceholder')}
              className="placeholder:text-muted-foreground"
              required
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-foreground/90 mb-2">
              {t('password')}
            </label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('passwordPlaceholder')}
              className="placeholder:text-muted-foreground"
              required
            />
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={loading}
          >
            {loading ? t('loggingIn') : t('loginButton')}
          </Button>
        </form>
      </div>
    </div>
  );
}
