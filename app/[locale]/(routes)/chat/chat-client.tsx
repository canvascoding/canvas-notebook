'use client';

import { useEffect } from 'react';

export default function ChatPageClient() {
  useEffect(() => {
    // Mobile sidebar toggle handler
    const handleToggleSidebar = () => {
      window.dispatchEvent(new CustomEvent('chat-toggle-mobile-sidebar'));
    };

    window.addEventListener('chat-toggle-mobile-sidebar', handleToggleSidebar);
    return () => {
      window.removeEventListener('chat-toggle-mobile-sidebar', handleToggleSidebar);
    };
  }, []);

  return null;
}
