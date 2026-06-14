import { requirePageSession } from '@/app/lib/auth-guards';
import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';

type StudioCreatePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function buildSearchString(searchParams: Record<string, string | string[] | undefined>) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, item);
      }
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }

  const query = params.toString();
  return query ? `?${query}` : '';
}

export default async function StudioCreatePage({ searchParams }: StudioCreatePageProps) {
  await requirePageSession();
  const [locale, resolvedSearchParams] = await Promise.all([
    getLocale(),
    searchParams ?? Promise.resolve({}),
  ]);

  redirect({ href: `/studio${buildSearchString(resolvedSearchParams)}`, locale });
}
