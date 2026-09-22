'use client';

import { useState, type ReactNode } from 'react';

/** Start reads only when needed; retain the mounted surface after its first visit. */
export function NotebookSurfaceMount({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  return active || visited ? children : null;
}
