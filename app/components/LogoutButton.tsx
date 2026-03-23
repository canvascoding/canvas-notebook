'use client';

import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { authClient } from '@/app/lib/auth-client';

export function LogoutButton() {
  const router = useRouter();
  const t = useTranslations('common');

  const handleLogout = async () => {
    try {
      await authClient.signOut({
        fetchOptions: {
          onSuccess: () => {
            router.push('/login');
            router.refresh();
          },
        },
      });
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  return (
    <Button
      onClick={handleLogout}
      variant="outline"
      size="sm"
      className="gap-2 px-2 sm:px-3"
    >
      <LogOut className="w-4 h-4" />
      <span className="hidden sm:inline">{t('logout')}</span>
    </Button>
  );
}
