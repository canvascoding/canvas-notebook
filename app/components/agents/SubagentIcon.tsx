'use client';

import Image from 'next/image';

import { cn } from '@/lib/utils';

export function SubagentIcon({ className }: { className?: string }) {
  return (
    <Image
      src="/images/agents/origami/subagents.svg"
      alt=""
      aria-hidden="true"
      width={64}
      height={64}
      sizes="64px"
      draggable={false}
      unoptimized
      data-agent-feature-icon="subagents"
      className={cn('select-none object-contain', className)}
    />
  );
}
