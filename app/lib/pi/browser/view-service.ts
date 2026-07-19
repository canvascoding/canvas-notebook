import 'server-only';

import type { KeyInput, Page } from 'puppeteer-core';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { control as controlAgentRuntime, getStatus as getAgentRuntimeStatus } from '@/app/lib/pi/runtime-service';

import {
  acceptPendingDialog,
  activateBrowserRuntimeTab,
  dismissPendingDialog,
  ensurePage,
  getActiveBrowserRuntimeTabId,
  getBrowserRuntimeTabs,
  getPendingDialogDetails,
  scheduleIdleClose,
  withBrowserRuntimeLock,
  type BrowserRuntimeContext,
} from './runtime';
import {
  assertBrowserUserControl,
  getBrowserControlState,
  refreshBrowserControlLease,
  releaseBrowserViewControl,
  setBrowserControlMode,
} from './view-control';
import { assertBrowserNavigationUrlAllowed } from './url-policy';
import { browserViewFailure } from './view-errors';
import type {
  BrowserViewControlMode,
  BrowserViewFailure,
  BrowserViewResourceBudget,
  BrowserViewState,
} from './types';
import type { BrowserViewTicketClaims } from './view-ticket';

export type BrowserViewServerMessage =
  | { type: 'ready'; viewId: string }
  | { type: 'frame'; sequence: number; mimeType: 'image/jpeg'; data: string; width: number; height: number }
  | { type: 'state'; state: BrowserViewState }
  | ({ type: 'error' } & BrowserViewFailure);

type BrowserViewSender = (message: BrowserViewServerMessage) => boolean;

const MAX_BUFFERED_FRAME_BYTES = 2 * 1024 * 1024;

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class BrowserViewService {
  readonly context: BrowserRuntimeContext;

  private captureTimer: NodeJS.Timeout | null = null;
  private captureInFlight = false;
  private closed = false;
  private sequence = 0;
  private acknowledgedSequence = 0;
  private lastState = '';
  private lastErrorCode = '';

  constructor(
    readonly claims: BrowserViewTicketClaims,
    readonly resourceBudget: BrowserViewResourceBudget,
    private readonly send: BrowserViewSender,
  ) {
    this.context = {
      userId: claims.userId,
      agentId: claims.agentId,
      sessionId: claims.agentSessionId,
      workspaceId: claims.workspaceId,
      workspaceType: claims.workspaceType,
      organizationId: claims.organizationId,
    };
  }

  async start(): Promise<void> {
    if (!this.resourceBudget.allowed) {
      throw new Error(this.resourceBudget.reason || 'Interactive browser view is unavailable.');
    }
    await withBrowserRuntimeLock(this.context, async () => {
      const page = await ensurePage(this.context);
      await this.applyViewport(page);
      scheduleIdleClose(this.context);
    });
    this.send({ type: 'ready', viewId: this.claims.viewId });
    await this.audit('browser_view.connect', { mode: getBrowserControlState(this.context).mode });
    await this.publishState(true);
    const intervalMs = Math.max(150, Math.round(1000 / this.resourceBudget.fps));
    this.captureTimer = setInterval(() => void this.captureFrame(), intervalMs);
    this.captureTimer.unref?.();
    await this.captureFrame();
  }

  private async applyViewport(page: Page): Promise<void> {
    const current = page.viewport();
    const target = this.resourceBudget.viewport;
    if (!current || current.width !== target.width || current.height !== target.height) {
      await page.setViewport(target);
    }
  }

  private async captureFrame(): Promise<void> {
    if (this.closed || this.captureInFlight) return;
    if (this.sequence > this.acknowledgedSequence) return;
    this.captureInFlight = true;
    try {
      const data = await withBrowserRuntimeLock(this.context, async () => {
        const page = await ensurePage(this.context);
        await this.applyViewport(page);
        scheduleIdleClose(this.context);
        const bytes = await page.screenshot({
          type: 'jpeg',
          quality: this.resourceBudget.jpegQuality,
          optimizeForSpeed: true,
          captureBeyondViewport: false,
        });
        return Buffer.from(bytes).toString('base64');
      });
      if (this.closed) return;
      const nextSequence = this.sequence + 1;
      const sent = this.send({
        type: 'frame',
        sequence: nextSequence,
        mimeType: 'image/jpeg',
        data,
        ...this.resourceBudget.viewport,
      });
      if (sent) this.sequence = nextSequence;
      if (!sent && Buffer.byteLength(data, 'base64') > MAX_BUFFERED_FRAME_BYTES) {
        this.lastErrorCode = 'FRAME_BACKPRESSURE';
      }
      await this.publishState(false);
      this.lastErrorCode = '';
    } catch (error) {
      this.publishError('CAPTURE_FAILED', error);
    } finally {
      this.captureInFlight = false;
    }
  }

  private publishError(_code: string, error: unknown): void {
    const failure = browserViewFailure(error, 'capture');
    if (this.closed || this.lastErrorCode === failure.code) return;
    this.lastErrorCode = failure.code;
    this.send({ type: 'error', ...failure });
  }

  async getState(): Promise<BrowserViewState> {
    return withBrowserRuntimeLock(this.context, async () => {
      const [tabs, page] = await Promise.all([
        getBrowserRuntimeTabs(this.context),
        ensurePage(this.context),
      ]);
      const control = getBrowserControlState(this.context);
      return {
        viewId: this.claims.viewId,
        agentId: this.claims.agentId,
        agentSessionId: this.claims.agentSessionId,
        workspaceId: this.claims.workspaceId,
        mode: control.mode,
        controlOwnerViewId: control.ownerViewId,
        leaseExpiresAt: control.leaseExpiresAt ? new Date(control.leaseExpiresAt).toISOString() : null,
        activeTabId: getActiveBrowserRuntimeTabId(this.context),
        title: await page.title().catch(() => ''),
        url: page.url(),
        tabs,
        pendingDialog: getPendingDialogDetails(this.context),
        viewport: this.resourceBudget.viewport,
        resourceBudget: this.resourceBudget,
      };
    });
  }

  async publishState(force: boolean): Promise<void> {
    if (this.closed) return;
    const state = await this.getState();
    const serialized = JSON.stringify(state);
    if (!force && serialized === this.lastState) return;
    this.lastState = serialized;
    this.send({ type: 'state', state });
  }

  async requestControl(mode: BrowserViewControlMode): Promise<void> {
    let abortedAgentRun = false;
    if (mode === 'user') {
      await withBrowserRuntimeLock(this.context, async () => {
        setBrowserControlMode({ context: this.context, viewId: this.claims.viewId, mode });
      });
      try {
        const status = await getAgentRuntimeStatus(this.claims.agentSessionId, this.claims.userId);
        if (status?.canAbort) {
          await controlAgentRuntime(this.claims.agentSessionId, this.claims.userId, 'abort');
          abortedAgentRun = true;
        }
      } catch (error) {
        await withBrowserRuntimeLock(this.context, async () => {
          setBrowserControlMode({ context: this.context, viewId: this.claims.viewId, mode: 'agent' });
        });
        throw error;
      }
    } else {
      await withBrowserRuntimeLock(this.context, async () => {
        setBrowserControlMode({ context: this.context, viewId: this.claims.viewId, mode });
      });
    }
    await this.audit('browser_view.control', { mode, abortedAgentRun });
    await this.publishState(true);
  }

  async navigate(url: string): Promise<void> {
    const allowedUrl = await assertBrowserNavigationUrlAllowed(url);
    await this.withUserControl(async (page) => {
      await page.goto(allowedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    });
    const target = new URL(allowedUrl);
    await this.audit('browser_view.navigate', {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || null,
    });
    await this.publishState(true);
  }

  async selectTab(tabId: string): Promise<void> {
    await this.withUserControl(async () => {
      await activateBrowserRuntimeTab(this.context, tabId);
    });
    await this.audit('browser_view.select_tab', { tabId });
    await this.publishState(true);
  }

  async mouse(input: {
    action: 'move' | 'down' | 'up' | 'click';
    x: number;
    y: number;
    button?: 'left' | 'middle' | 'right';
  }): Promise<void> {
    await this.withUserControl(async (page) => {
      const x = clamp(finiteNumber(input.x), 0, this.resourceBudget.viewport.width);
      const y = clamp(finiteNumber(input.y), 0, this.resourceBudget.viewport.height);
      const button = input.button === 'middle' || input.button === 'right' ? input.button : 'left';
      if (input.action === 'move') await page.mouse.move(x, y);
      else if (input.action === 'down') await page.mouse.down({ button });
      else if (input.action === 'up') await page.mouse.up({ button });
      else await page.mouse.click(x, y, { button });
    });
  }

  async key(input: { key: string; text?: string; modifiers?: string[] }): Promise<void> {
    const key = input.key.trim().slice(0, 40) as KeyInput;
    if (!key) throw new Error('A keyboard key is required.');
    const text = typeof input.text === 'string' ? input.text.slice(0, 8) : undefined;
    const modifiers = (input.modifiers ?? [])
      .filter((modifier): modifier is 'Alt' | 'Control' | 'Meta' | 'Shift' => (
        modifier === 'Alt' || modifier === 'Control' || modifier === 'Meta' || modifier === 'Shift'
      ));
    await this.withUserControl(async (page) => {
      for (const modifier of modifiers) await page.keyboard.down(modifier);
      try {
        await page.keyboard.press(key, text ? { text } : undefined);
      } finally {
        for (const modifier of modifiers.reverse()) await page.keyboard.up(modifier);
      }
    });
  }

  async scroll(input: { deltaX?: number; deltaY?: number }): Promise<void> {
    await this.withUserControl(async (page) => {
      await page.mouse.wheel({
        deltaX: clamp(finiteNumber(input.deltaX), -2000, 2000),
        deltaY: clamp(finiteNumber(input.deltaY), -2000, 2000),
      });
    });
  }

  async resolveDialog(accept: boolean, promptText?: string): Promise<void> {
    await this.withUserControl(async () => {
      if (accept) await acceptPendingDialog(this.context, promptText?.slice(0, 500));
      else await dismissPendingDialog(this.context);
    });
    await this.audit('browser_view.resolve_dialog', { accepted: accept });
    await this.publishState(true);
  }

  heartbeat(): void {
    refreshBrowserControlLease(this.context, this.claims.viewId);
    scheduleIdleClose(this.context);
  }

  acknowledgeFrame(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence <= this.acknowledgedSequence || sequence > this.sequence) return;
    this.acknowledgedSequence = sequence;
  }

  private async withUserControl<T>(operation: (page: Page) => Promise<T>): Promise<T> {
    return withBrowserRuntimeLock(this.context, async () => {
      assertBrowserUserControl(this.context, this.claims.viewId);
      refreshBrowserControlLease(this.context, this.claims.viewId);
      const page = await ensurePage(this.context);
      const result = await operation(page);
      scheduleIdleClose(this.context);
      return result;
    });
  }

  private async audit(action: string, metadata: Record<string, unknown>): Promise<void> {
    await recordAuditEvent({
      organizationId: this.claims.organizationId,
      workspaceId: this.claims.workspaceId,
      userId: this.claims.userId,
      sessionId: this.claims.agentSessionId,
      agentId: this.claims.agentId,
      source: 'browser_lab',
      eventType: 'browser_view',
      entityType: 'browser_view',
      entityId: this.claims.viewId,
      action,
      status: 'success',
      summary: 'Interactive browser view action completed.',
      metadata,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.captureTimer) clearInterval(this.captureTimer);
    this.captureTimer = null;
    releaseBrowserViewControl(this.context, this.claims.viewId);
    void this.audit('browser_view.disconnect', { releasedControl: true });
  }
}
