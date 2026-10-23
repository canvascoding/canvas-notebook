'use client';

import { useRef } from 'react';

/** A menu that opened a dialog no longer owns the eventual focus return.
 * Its exit animation may finish after that dialog has already closed. */
export function useMenuDialogFocusHandoff() {
  const handedOff = useRef(false);
  return {
    onOpenChange(open: boolean) {
      if (open) handedOff.current = false;
    },
    openDialog(open: () => void) {
      handedOff.current = true;
      try { open(); }
      catch (error) { handedOff.current = false; throw error; }
    },
    onCloseAutoFocus(event: Event) {
      if (!handedOff.current) return;
      event.preventDefault();
    },
  };
}
