'use client';

import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import { toast, type ExternalToast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';

export const MOBILE_FILE_ACTION_TOASTER_ID = 'mobile-explorer-file-actions';
const FileActionToastContext = createContext<string | undefined>(undefined);

/** Toast actions belong inside the Explorer's modal focus and pointer boundary. */
export function FileActionToastScope({ children }: { children: ReactNode }) {
  useEffect(() => () => {
    // Closing Explorer must keep an outstanding Undo action or completion message visible.
    for (const notification of toast.getToasts()) {
      if ('toasterId' in notification && notification.toasterId === MOBILE_FILE_ACTION_TOASTER_ID) {
        toast.message(notification.title, { ...notification, toasterId: undefined });
      }
    }
  }, []);

  return <FileActionToastContext.Provider value={MOBILE_FILE_ACTION_TOASTER_ID}>
    {children}
    <div data-file-action-toast-scope={MOBILE_FILE_ACTION_TOASTER_ID}>
      <Toaster id={MOBILE_FILE_ACTION_TOASTER_ID} richColors position="top-right" />
    </div>
  </FileActionToastContext.Provider>;
}

/** Resolve at publication time because an asynchronous action may outlive the Sheet. */
export function useFileActionToastTarget(explicitToasterId?: string) {
  const contextualToasterId = useContext(FileActionToastContext);
  const toasterId = explicitToasterId ?? contextualToasterId;
  return useCallback((): Pick<ExternalToast, 'toasterId'> => {
    if (!toasterId || typeof document === 'undefined') return {};
    const host = document.querySelector(`[data-file-action-toast-scope="${toasterId}"]`);
    return host?.closest('[data-slot="sheet-content"]')?.getAttribute('data-state') === 'open'
      ? { toasterId } : {};
  }, [toasterId]);
}
