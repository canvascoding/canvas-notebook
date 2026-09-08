'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function ShareExpiryField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const t = useTranslations('fileSharing');
  const id = useId();
  return <div className="min-w-0 space-y-1.5">
    <Label htmlFor={id}>{t('expiry')}</Label>
    <Input id={id} type="datetime-local" value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} className="min-w-0" />
    <p className="text-xs text-muted-foreground">{t('expiryHelp')}</p>
  </div>;
}
