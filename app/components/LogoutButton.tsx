'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { LogOut } from 'lucide-react';
import { authClient } from '@/app/lib/auth-client';

export function LogoutButton() {
  const router = useRouter();

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
      className="gap-2"
    >
      <LogOut className="w-4 h-4" />
      Logout
    </Button>
  );
}
