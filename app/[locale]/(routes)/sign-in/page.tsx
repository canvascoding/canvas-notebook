import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';

export default async function SignInPage() {
  const locale = await getLocale();
  redirect({ href: '/login', locale });
}
