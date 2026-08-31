'use client';

import type { SVGProps } from 'react';

import { AgentIcon } from '@/app/components/agents/AgentAvatar';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { cn } from '@/lib/utils';

export function BradleyGlyph({
  className,
  state = 'idle',
  title,
  ...props
}: SVGProps<SVGSVGElement> & {
  state?: 'idle' | 'working';
  title?: string;
}) {
  const isWorking = state === 'working';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      className={cn('shrink-0 [forced-color-adjust:auto]', className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {isWorking ? (
        <style>{`
          .bradley-working-character {
            animation: bradley-working-hover 2.4s cubic-bezier(.4, 0, .2, 1) infinite;
            transform-box: view-box;
            transform-origin: 32px 36px;
            will-change: transform;
          }
          .bradley-working-fold {
            animation: bradley-working-fold 2.4s cubic-bezier(.4, 0, .2, 1) infinite;
            transform-box: view-box;
            transform-origin: 40px 33px;
            will-change: transform;
          }
          .bradley-working-bar {
            animation: bradley-working-bar 1.2s ease-in-out infinite;
            opacity: .45;
            will-change: opacity;
          }
          .bradley-working-bar-b { animation-delay: .16s; }
          .bradley-working-bar-c { animation-delay: .32s; }
          @keyframes bradley-working-hover {
            0%, 100% { transform: translateY(0) scale(1); }
            50% { transform: translateY(-1.15px) scale(1.008); }
          }
          @keyframes bradley-working-fold {
            0%, 18%, 72%, 100% { transform: rotate(0deg) translateY(0); }
            42% { transform: rotate(-2.4deg) translateY(-.35px); }
          }
          @keyframes bradley-working-bar {
            0%, 100% { opacity: .4; }
            50% { opacity: 1; }
          }
          @media (prefers-reduced-motion: reduce) {
            .bradley-working-character,
            .bradley-working-fold,
            .bradley-working-bar {
              animation: none !important;
              transform: none !important;
            }
            .bradley-working-bar { opacity: 1; }
          }
        `}</style>
      ) : null}
      <g className={isWorking ? 'bradley-working-character' : undefined}>
        <path
          d="M35.5 31.5 55.7 31.1c2.1 0 3.8 1.8 3.6 3.9l-1.8 20.7a3.4 3.4 0 0 1-3.6 3.1l-10.7-.6-10.6-8.5Z"
          fill="#1469D3"
        />
        <path
          d="M15.3 8.9 48.1 4.4a3.6 3.6 0 0 1 4 3l4 26.2-13 12.8-13.9 12.9H11.4a3.5 3.5 0 0 1-3.5-3.8l2.7-38.8a8.5 8.5 0 0 1 4.7-7.8Z"
          fill="#2F8CFF"
        />
        <path
          d="m15.3 8.9-4.7 7.8-2.7 38.8a3.5 3.5 0 0 0 3.5 3.8h3.1l2.4-43.7Z"
          fill="#63B1FF"
        />
        <path
          d="m8 55.5 35.1-9.1-13.9 12.9H11.4A3.5 3.5 0 0 1 8 55.5Z"
          fill="#1876E4"
        />
        <g className={isWorking ? 'bradley-working-fold' : undefined}>
          <path
            d="m41.4 27.1 14.1 5.1a5.8 5.8 0 0 1 3.8 6.1l-1.2 11.1-12.7-5.6-8.3-9.8 2.2-5.5a1.8 1.8 0 0 1 2.1-1.4Z"
            fill="#4DA3FF"
          />
          <path
            d="m39.3 28.5-2.2 5.5 7.1 2.7-2.8-9.6a1.8 1.8 0 0 0-2.1 1.4Z"
            fill="#79BCFF"
          />
        </g>
        <g fill="#172033">
          <circle cx="27.1" cy="22.1" r="2.6" />
          <circle cx="39.4" cy="20.4" r="2.6" />
        </g>
      </g>
      {isWorking ? (
        <g aria-hidden="true">
          <rect x="44.5" y="43" width="15" height="15" rx="2.5" fill="#172033" />
          <rect className="bradley-working-bar" x="48" y="49" width="1.8" height="5" rx=".9" fill="#fff" />
          <rect className="bradley-working-bar bradley-working-bar-b" x="51.2" y="47" width="1.8" height="7" rx=".9" fill="#fff" />
          <rect className="bradley-working-bar bradley-working-bar-c" x="54.4" y="45" width="1.8" height="9" rx=".9" fill="#fff" />
        </g>
      ) : null}
    </svg>
  );
}

export function AgentIdentityIcon({
  agentId,
  iconId,
  className,
  state = 'idle',
}: {
  agentId: string;
  iconId?: string | null;
  className?: string;
  state?: 'idle' | 'working';
}) {
  if (agentId === DEFAULT_AGENT_ID) {
    return <BradleyGlyph className={className} state={state} />;
  }

  return <AgentIcon iconId={iconId} className={className} />;
}

export function AgentIdentityAvatar({
  agentId,
  iconId,
  className,
  iconClassName,
}: {
  agentId: string;
  iconId?: string | null;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-foreground',
        className,
      )}
      aria-hidden="true"
    >
      <AgentIdentityIcon
        agentId={agentId}
        iconId={iconId}
        className={cn('h-5 w-5', iconClassName)}
      />
    </span>
  );
}
