'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { authClient } from '@/app/lib/auth-client';
import { checkEmailAttachmentPreviewAccess, EmailAttachmentPreviewError, loadEmailAttachmentPreviewResource,
  type EmailAttachmentPreviewItem, type EmailAttachmentPreviewResource } from '@/app/lib/email/attachment-preview';
import { EmailAttachmentPreviewDialog } from './EmailAttachmentPreviewDialog';

type Selection = { context: string; itemId: string; activation: number; trigger: HTMLElement | null };
type LoadState = { key: string; resource: EmailAttachmentPreviewResource | null; loading: boolean; error: string | null };

export function useEmailAttachmentPreview(items: EmailAttachmentPreviewItem[], contextKey: string, onAccessChanged?: () => void) {
  const t = useTranslations('emailAttachmentPreview');
  const { data: session } = authClient.useSession();
  const actorKey = session ? JSON.stringify([session.user.id, session.session.id]) : '';
  const context = JSON.stringify([actorKey, contextKey]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [load, setLoad] = useState<LoadState>({ key: '', resource: null, loading: false, error: null });
  const serialRef = useRef(0);
  if (selection && (selection.context !== context || !items.some(candidate => candidate.id === selection.itemId))) setSelection(null);
  const close = () => {
    const trigger = selection?.trigger;
    setSelection(null);
    window.requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  };
  const activeIndex = selection?.context === context && actorKey ? items.findIndex(item => item.id === selection.itemId) : -1;
  const item = activeIndex >= 0 ? items[activeIndex] : null;
  const itemKey = item ? JSON.stringify([context, selection?.activation, item]) : '';
  const requestItem = useMemo(() => itemKey ? JSON.parse(itemKey)[2] as EmailAttachmentPreviewItem : null, [itemKey]);
  const currentKeyRef = useRef(itemKey);
  const currentAccessChanged = useRef(onAccessChanged);
  useLayoutEffect(() => { currentKeyRef.current = itemKey; currentAccessChanged.current = onAccessChanged; }, [itemKey, onAccessChanged]);

  useEffect(() => authClient.$store.atoms.$sessionSignal.listen(() => {
    currentKeyRef.current = '';
    setSelection(null);
  }), []);
  useEffect(() => {
    if (!requestItem || !itemKey) return;
    const controller = new AbortController();
    let resource: EmailAttachmentPreviewResource | null = null;
    let authority: AbortController | null = null;
    let checking = false;
    const current = () => !controller.signal.aborted && currentKeyRef.current === itemKey;
    const release = () => { if (resource) { URL.revokeObjectURL(resource.objectUrl); resource = null; } };
    const fail = (error: unknown) => {
      if (!current()) return;
      release();
      const code = error instanceof EmailAttachmentPreviewError ? error.code : 'failed';
      setLoad({ key: itemKey, resource: null, loading: false, error: code });
      if (error instanceof EmailAttachmentPreviewError && [401, 403, 409].includes(error.status)) currentAccessChanged.current?.();
    };
    const deadline = window.setTimeout(() => {
      if (!current()) return;
      fail(new EmailAttachmentPreviewError('failed')); controller.abort();
    }, 30_000);
    void loadEmailAttachmentPreviewResource(requestItem, controller.signal).then(loaded => {
      if (!current()) { URL.revokeObjectURL(loaded.objectUrl); return; }
      resource = loaded;
      setLoad({ key: itemKey, resource, loading: false, error: null });
    }).catch(fail).finally(() => window.clearTimeout(deadline));
    const recheck = async () => {
      if (!current() || !resource || checking || document.visibilityState !== 'visible') return;
      checking = true;
      authority = new AbortController();
      const timeout = window.setTimeout(() => authority?.abort(), 15_000);
      try { await checkEmailAttachmentPreviewAccess(requestItem, authority.signal, true); }
      catch (error) { fail(error); }
      finally { window.clearTimeout(timeout); authority = null; checking = false; }
    };
    const onVisible = () => { void recheck(); };
    const timer = window.setInterval(onVisible, 30_000);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.abort(); authority?.abort(); release();
      window.clearTimeout(deadline); window.clearInterval(timer);
      window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible);
    };
  }, [itemKey, requestItem]);

  const navigate = (offset: number) => {
    if (!selection || activeIndex < 0 || !items.length) return;
    setSelection({ ...selection, activation: ++serialRef.current, itemId: items[(activeIndex + offset + items.length) % items.length].id });
  };
  const current = load.key === itemKey ? load : null;
  return {
    canOpen: Boolean(actorKey),
    openLabel: (name: string) => t('open', { name }),
    openAttachment: (itemId: string) => {
      if (actorKey && items.some(candidate => candidate.id === itemId)) setSelection({ context, activation: ++serialRef.current, itemId, trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null });
    },
    dialog: item && <EmailAttachmentPreviewDialog key={context} item={item} resource={current?.resource ?? null}
      error={current?.error ?? null} loading={!current || current.loading} index={activeIndex} count={items.length}
      onPrevious={() => navigate(-1)} onNext={() => navigate(1)} onClose={close} />,
  };
}
