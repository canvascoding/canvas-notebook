import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { PiRuntimePromptContext } from '@/app/lib/pi/runtime-prompt-context';

export type RuntimeQueuePreview = {
  id: string;
  text: string;
  attachmentCount: number;
  clientMessageId?: string;
  messageTimestamp?: number;
  signature?: string;
};

export type RuntimeQueueEntry = {
  id: string;
  preview: RuntimeQueuePreview;
  message: Extract<AgentMessage, { role: 'user' }>;
  signature: string;
  context?: PiRuntimePromptContext;
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
  }

  private attachNextFollowUp(agent: RuntimeQueueAgent): void {
    if (this.followUpsSuspended || this.attachedFollowUpId) {
      return;
    }

    const nextEntry = this.followUps[0];
    if (!nextEntry) {
      return;
    }

    this.attachedFollowUpId = nextEntry.id;
    agent.followUp(nextEntry.message);
  }

}
