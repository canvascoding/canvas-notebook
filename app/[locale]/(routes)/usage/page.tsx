import { redirect } from 'next/navigation';
import { getPathname } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';

export default async function UsagePage() {
  const locale = await getLocale();
  const settingsUrl = getPathname({ href: '/settings', locale }) + '?tab=usage';
  redirect(settingsUrl);
}