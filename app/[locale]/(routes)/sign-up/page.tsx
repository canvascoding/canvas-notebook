import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';
import { hasAnyAuthUser } from '@/app/lib/auth-setup';

export default async function SignUpPage() {
  const locale = await getLocale();
  if (!(await hasAnyAuthUser())) {
    redirect({ href: '/setup', locale });
  }
  redirect({ href: '/login', locale });
}
