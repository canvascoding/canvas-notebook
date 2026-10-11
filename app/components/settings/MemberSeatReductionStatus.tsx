'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { MemberSeatReductionStatus } from '@/app/lib/organization/member-seat-reduction-status';

export function useMemberSeatReductionStatuses(userIds: string[], enabled: boolean, refreshKey: unknown) {
  const selection = [...new Set(userIds)].sort().join('\n');
  const [snapshot, setSnapshot] = useState<{
    refreshKey: unknown;
    statuses: Record<string, MemberSeatReductionStatus>;
    unavailable: boolean;
  }>({ refreshKey: null, statuses: {}, unavailable: false });
  useEffect(() => {
    if (!enabled || !selection) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const selected = selection.split('\n');
    const query = new URLSearchParams();
    for (const userId of selected) query.append('userId', userId);
    const load = async () => {
      try {
        const response = await fetch(`/api/admin/organization/users/seat-reductions?${query}`, {
          cache: 'no-store', credentials: 'include', signal: controller.signal,
        });
        const payload = await response.json() as {
          success?: boolean; data?: { reductions?: MemberSeatReductionStatus[] };
        };
        if (!response.ok || !payload.success || !Array.isArray(payload.data?.reductions)) {
          throw new Error('Seat reduction status unavailable.');
        }
        if (disposed) return;
        const reductions = payload.data.reductions.filter((status) => selected.includes(status.userId));
        setSnapshot({
          refreshKey,
          statuses: Object.fromEntries(reductions.map((status) => [status.userId, status])),
          unavailable: false,
        });
        if (reductions.some((status) => status.state === 'pending')) timer = setTimeout(load, 4_000);
      } catch {
        if (disposed) return;
        setSnapshot((previous) => ({
          refreshKey,
          statuses: previous.refreshKey === refreshKey ? previous.statuses : {},
          unavailable: true,
        }));
        timer = setTimeout(load, 15_000);
      }
    };
    void load();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, selection, refreshKey]);
  return enabled && selection && snapshot.refreshKey === refreshKey
    ? { statuses: snapshot.statuses, unavailable: snapshot.unavailable }
    : { statuses: {}, unavailable: false };
}

export function MemberSeatReductionStatusLabel({ status, unavailable }: {
  status?: MemberSeatReductionStatus; unavailable: boolean;
}) {
  const t = useTranslations('settings.users.seatReduction');
  if (!status && !unavailable) return null;
  return (
    <span aria-live="polite" className={`max-w-56 text-xs ${
      unavailable || status?.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'
    }`}>
      {unavailable ? t('unavailable') : t(status!.state)}
    </span>
  );
}
