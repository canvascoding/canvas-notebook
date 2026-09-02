'use client';

import { UserRound } from 'lucide-react';

import { AgentIdentityAvatar } from '@/app/components/agents/AgentIdentityVisual';
import { UserAvatar } from '@/app/components/user-profile/UserAvatar';
import type { ResolvedUserProfile } from '@/app/lib/user-profile/types';

export function ChatMessageIdentity({
  role,
  agentId,
  agentIconId,
  userProfile,
}: {
  role: 'user' | 'assistant';
  agentId: string;
  agentIconId?: string | null;
  userProfile: ResolvedUserProfile | null;
}) {
  if (role === 'assistant') {
    return (
      <span aria-hidden="true" data-testid="chat-message-identity-assistant" className="inline-flex size-5 shrink-0">
        <AgentIdentityAvatar
          agentId={agentId}
          iconId={agentIconId}
          className="size-5 border-foreground/10 bg-background/80 text-foreground shadow-none"
          iconClassName="size-3.5"
        />
      </span>
    );
  }

  return (
    <span aria-hidden="true" data-testid="chat-message-identity-user" className="inline-flex size-5 shrink-0">
      {userProfile ? (
        <UserAvatar
          profile={userProfile}
          className="size-5 rounded-md border-white/25 bg-background/95 text-foreground shadow-none"
          iconClassName="size-3"
        />
      ) : (
        <span className="inline-flex size-5 items-center justify-center rounded-md border border-white/25 bg-background/95 text-foreground">
          <UserRound aria-hidden="true" className="size-3" strokeWidth={1.8} />
        </span>
      )}
    </span>
  );
}
