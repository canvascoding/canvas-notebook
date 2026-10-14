import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { PiRuntimePromptContext } from '@/app/lib/pi/runtime-prompt-context';
import type { ChatBodyV1 } from '@/app/lib/chat/chat-body-contracts';
import type { ChatMessageQueueState, OwnedAcceptedChatMessage } from './durable-message-admission';

export type RuntimeQueuePreview = {
  id: string;
  text: string;
  attachmentCount: number;
  clientMessageId?: string;
  messageTimestamp?: number;
  signature?: string;
  body?: ChatBodyV1;
};

export type RuntimeQueueEntry = {
  id: string;
  preview: RuntimeQueuePreview;
  message: Extract<AgentMessage, { role: 'user' }>;
  signature: string;
  context?: PiRuntimePromptContext;
  durable?: { message: OwnedAcceptedChatMessage; queue: ChatMessageQueueState };
};

type RuntimeQueueAgent = {
  followUp: (message: AgentMessage) => void;
  steer: (message: AgentMessage) => void;
  clearFollowUpQueue: () => void;
  clearSteeringQueue: () => void;
  clearAllQueues: () => void;
};

export class RuntimeMessageQueues {
  readonly followUps: RuntimeQueueEntry[] = [];
  readonly steering: RuntimeQueueEntry[] = [];
  private followUpsSuspended = false;
  private attachedFollowUpId: string | null = null;
  private attachedDurable: { id: string; lane: 'follow_up' | 'steer' } | null = null;
  private continuation: AgentMessage | null = null;

  enqueueContinuation(message: AgentMessage, agent: RuntimeQueueAgent): void {
    this.continuation = message;
    agent.followUp(message);
  }

  consumeContinuation(message: AgentMessage): void {
    if (this.continuation === message) this.continuation = null;
  }

  discardContinuation(agent: RuntimeQueueAgent): void {
    if (!this.continuation) return;
    this.continuation = null;
    agent.clearFollowUpQueue();
    if (this.attachedFollowUpId) {
      const entry = this.followUps.find(candidate => candidate.id === this.attachedFollowUpId);
      if (entry) agent.followUp(entry.message);
    }
    if (this.attachedDurable?.lane === 'follow_up') {
      const entry = this.followUps.find(candidate => candidate.id === this.attachedDurable!.id);
      if (entry) agent.followUp(entry.message);
    }
  }

  /** SQL owns eligibility; this existing scheduler owns the single SDK attachment. */
  reconcileDurable(entries: readonly RuntimeQueueEntry[], agent: RuntimeQueueAgent, attach = true): void {
    this.followUps.splice(0, this.followUps.length, ...this.followUps.filter(entry => !entry.durable),
      ...entries.filter(entry => entry.durable?.queue.lane !== 'steer'));
    this.steering.splice(0, this.steering.length, ...this.steering.filter(entry => !entry.durable),
      ...entries.filter(entry => entry.durable?.queue.lane === 'steer'));
    this.attachDurableHead(agent, attach);
  }

  private attachDurableHead(agent: RuntimeQueueAgent, attach = true): void {
    const next = attach ? [...this.followUps, ...this.steering]
      .filter(entry => entry.durable?.queue.disposition === 'ready')
      .sort((left, right) => left.durable!.queue.ordinal - right.durable!.queue.ordinal)[0] : undefined;
    const nextLane = next?.durable?.queue.lane === 'steer' ? 'steer' : 'follow_up';
    if (next?.id === this.attachedDurable?.id && (!next || nextLane === this.attachedDurable?.lane)) return;
    const previous = this.attachedDurable;
    this.attachedDurable = null;
    if (previous?.lane === 'follow_up') {
      agent.clearFollowUpQueue();
      if (this.continuation) agent.followUp(this.continuation);
      this.attachedFollowUpId = null;
      this.attachNextFollowUp(agent);
    } else if (previous?.lane === 'steer') {
      agent.clearSteeringQueue();
      for (const entry of this.steering.filter(candidate => !candidate.durable)) agent.steer(entry.message);
    }
    if (!next) return;
    const lane = next.durable!.queue.lane === 'steer' ? 'steer' : 'follow_up';
    this.attachedDurable = { id: next.id, lane };
    if (lane === 'steer') agent.steer(next.message);
    else agent.followUp(next.message);
  }

  /** The SDK has already drained this exact entry; never remove by display text. */
  consumeDurable(id: string, agent: RuntimeQueueAgent, attach = true): void {
    for (const entries of [this.followUps, this.steering]) {
      const index = entries.findIndex(entry => entry.durable && entry.id === id);
      if (index !== -1) entries.splice(index, 1);
    }
    if (this.attachedDurable?.id === id) this.attachedDurable = null;
    this.attachDurableHead(agent, attach);
  }

  enqueueFollowUp(entry: RuntimeQueueEntry, agent: RuntimeQueueAgent): void {
    this.followUps.push(entry);
    this.attachNextFollowUp(agent);
  }

  enqueueSteering(entry: RuntimeQueueEntry, agent: RuntimeQueueAgent): void {
    this.trackSteering(entry);
    agent.steer(entry.message);
  }

  trackSteering(entry: RuntimeQueueEntry): void {
    this.steering.push(entry);
  }

  promoteFollowUp(queueItemId: string, agent: RuntimeQueueAgent): RuntimeQueueEntry | null {
    const followUpIndex = this.followUps.findIndex((entry) => entry.preview.id === queueItemId || entry.id === queueItemId);
    if (followUpIndex === -1) {
      return null;
    }

    const [entry] = this.followUps.splice(followUpIndex, 1);
    if (!entry) {
      return null;
    }

    // Agent-core continues draining every follow-up after a steering turn. Keep
    // the remaining entries runtime-owned so Steer injects only this entry.
    agent.clearFollowUpQueue();
    this.attachedFollowUpId = null;
    this.attachedDurable = null;
    this.continuation = null;
    this.followUpsSuspended = this.followUps.length > 0;
    return entry;
  }

  remove(queueItemId: string, agent: RuntimeQueueAgent): 'follow_up' | 'steer' | null {
    const followUpIndex = this.followUps.findIndex((entry) => entry.preview.id === queueItemId || entry.id === queueItemId);
    if (followUpIndex !== -1) {
      const [removed] = this.followUps.splice(followUpIndex, 1);
      if (this.followUpsSuspended) {
        if (this.followUps.length === 0) {
          this.followUpsSuspended = false;
        }
      } else if (removed?.id === this.attachedFollowUpId) {
        agent.clearFollowUpQueue();
        this.attachedFollowUpId = null;
        this.attachNextFollowUp(agent);
      }
      return 'follow_up';
    }

    const steeringIndex = this.steering.findIndex((entry) => entry.preview.id === queueItemId || entry.id === queueItemId);
    if (steeringIndex === -1) {
      return null;
    }

    this.steering.splice(steeringIndex, 1);
    agent.clearSteeringQueue();
    for (const entry of this.steering) {
      agent.steer(entry.message);
    }
    return 'steer';
  }

  consume(signature: string, agent: RuntimeQueueAgent): void {
    const steeringIndex = this.steering.findIndex((entry) => entry.signature === signature);
    if (steeringIndex !== -1) {
      this.steering.splice(steeringIndex, 1);
      if (this.steering.length === 0 && this.followUpsSuspended) {
        this.followUpsSuspended = false;
        this.attachNextFollowUp(agent);
      }
      return;
    }

    const followUpIndex = this.followUps.findIndex((entry) => entry.signature === signature);
    if (followUpIndex !== -1) {
      const [consumed] = this.followUps.splice(followUpIndex, 1);
      if (consumed?.id === this.attachedFollowUpId) {
        this.attachedFollowUpId = null;
      }
      if (this.followUps.length === 0) {
        this.followUpsSuspended = false;
      }
      this.attachNextFollowUp(agent);
    }
  }

  clear(agent: RuntimeQueueAgent): void {
    agent.clearAllQueues();
    this.followUps.length = 0;
    this.steering.length = 0;
    this.followUpsSuspended = false;
    this.attachedFollowUpId = null;
    this.attachedDurable = null;
    this.continuation = null;
  }

  private attachNextFollowUp(agent: RuntimeQueueAgent): void {
    if (this.followUpsSuspended || this.attachedFollowUpId) {
      return;
    }

    const nextEntry = this.followUps.find(entry => !entry.durable);
    if (!nextEntry) {
      return;
    }

    this.attachedFollowUpId = nextEntry.id;
    agent.followUp(nextEntry.message);
  }

}
