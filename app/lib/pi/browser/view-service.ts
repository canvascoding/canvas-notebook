import 'server-only';

import type { Protocol } from 'devtools-protocol';
import type { CDPSession, FileChooser, KeyInput, Page } from 'puppeteer-core';

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
import {
  MAX_BROWSER_DOWNLOAD_FILE_BYTES,
  cleanupBrowserDownloadStagingFile,
  moveBrowserDownloadIntoWorkspace,
  prepareBrowserDownloadStagingDirectory,
  resolveBrowserUploadFiles,
  resolveCompletedBrowserDownloadSource,
  sanitizeBrowserDownloadFileName,
} from './view-transfers';
import type {
  BrowserViewControlMode,
  BrowserViewDownload,
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
const MAX_VISIBLE_DOWNLOADS = 5;

type PageTransferBinding = {
  pageClient: CDPSession;
  frameIds: Set<string>;
  activeDownloadId: string | null;
  downloads: Map<string, { fileName: string; accepted: boolean }>;
};

function collectFrameIds(frameTree: Protocol.Page.FrameTree, frameIds = new Set<string>()): Set<string> {
  frameIds.add(frameTree.frame.id);
  for (const child of frameTree.childFrames ?? []) collectFrameIds(child, frameIds);
  return frameIds;
}

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
  private pendingFileChooser: { chooser: FileChooser; page: Page; openedAt: string } | null = null;
  private fileChooserWatches = new Map<Page, Promise<void>>();
  private pageTransfers = new Map<Page, PageTransferBinding>();
  private browserDownloadClient: CDPSession | null = null;
  private downloadStagingDirectory: string | null = null;
  private downloads = new Map<string, BrowserViewDownload>();

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
      await this.ensurePageTransfers(page);
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
        await this.ensurePageTransfers(page);
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

  private publishTransferError(error: unknown): void {
    const failure = browserViewFailure(error, 'operation');
    if (this.closed) return;
    this.send({ type: 'error', ...failure });
  }

  private armFileChooser(page: Page): void {
    if (this.closed || page.isClosed() || this.fileChooserWatches.has(page)) return;
    const watch = page.waitForFileChooser({ timeout: 0 })
      .then(async (chooser) => {
        if (this.closed || page.isClosed()) {
          await chooser.cancel().catch(() => undefined);
          return;
        }
        if (this.pendingFileChooser) {
          await chooser.cancel().catch(() => undefined);
          return;
        }
        this.pendingFileChooser = { chooser, page, openedAt: new Date().toISOString() };
        await this.publishState(true).catch(() => undefined);
      })
      .catch(() => undefined)
      .finally(() => {
        this.fileChooserWatches.delete(page);
      });
    this.fileChooserWatches.set(page, watch);
  }

  private async ensurePageTransfers(page: Page): Promise<void> {
    this.armFileChooser(page);
    if (this.pageTransfers.has(page)) return;

    if (!this.browserDownloadClient) {
      const stagingDirectory = await prepareBrowserDownloadStagingDirectory();
      const browserClient = await page.browser().target().createCDPSession();
      await browserClient.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: stagingDirectory,
        eventsEnabled: true,
      });
      browserClient.on('Browser.downloadWillBegin', (event: Protocol.Browser.DownloadWillBeginEvent) => {
        void this.handleDownloadWillBegin(event);
      });
      browserClient.on('Browser.downloadProgress', (event: Protocol.Browser.DownloadProgressEvent) => {
        void this.handleDownloadProgress(event);
      });
      this.browserDownloadClient = browserClient;
      this.downloadStagingDirectory = stagingDirectory;
    }

    const pageClient = await page.createCDPSession();
    const frameTree = await pageClient.send('Page.getFrameTree');
    const binding: PageTransferBinding = {
      pageClient,
      frameIds: collectFrameIds(frameTree.frameTree),
      activeDownloadId: null,
      downloads: new Map(),
    };
    this.pageTransfers.set(page, binding);
    pageClient.on('Page.frameAttached', (event: Protocol.Page.FrameAttachedEvent) => {
      binding.frameIds.add(event.frameId);
    });
    pageClient.on('Page.frameDetached', (event: Protocol.Page.FrameDetachedEvent) => {
      binding.frameIds.delete(event.frameId);
    });
    page.once('close', () => {
      if (this.pendingFileChooser?.page === page) this.pendingFileChooser = null;
      void this.releasePageTransfers(page);
    });
  }

  private async handleDownloadWillBegin(
    event: Protocol.Browser.DownloadWillBeginEvent,
  ): Promise<void> {
    if (this.closed) return;
    const binding = Array.from(this.pageTransfers.values()).find((candidate) => candidate.frameIds.has(event.frameId));
    if (!binding) return;
    const fileName = sanitizeBrowserDownloadFileName(event.suggestedFilename);
    if (binding.activeDownloadId) {
      binding.downloads.set(event.guid, { fileName, accepted: false });
      this.downloads.set(event.guid, {
        id: event.guid,
        fileName,
        status: 'canceled',
        receivedBytes: 0,
        totalBytes: 0,
        workspacePath: null,
      });
      await this.browserDownloadClient?.send('Browser.cancelDownload', { guid: event.guid }).catch(() => undefined);
      this.publishTransferError(new Error('Browser download could not be started while another download is active.'));
      await this.publishState(true).catch(() => undefined);
      return;
    }
    binding.activeDownloadId = event.guid;
    binding.downloads.set(event.guid, { fileName, accepted: true });
    this.downloads.set(event.guid, {
      id: event.guid,
      fileName,
      status: 'in_progress',
      receivedBytes: 0,
      totalBytes: 0,
      workspacePath: null,
    });
    await this.publishState(true).catch(() => undefined);
  }

  private async handleDownloadProgress(
    event: Protocol.Browser.DownloadProgressEvent,
  ): Promise<void> {
    const binding = Array.from(this.pageTransfers.values()).find((candidate) => candidate.downloads.has(event.guid));
    if (!binding) return;
    const record = binding.downloads.get(event.guid);
    const state = this.downloads.get(event.guid);
    if (!record || !state || this.closed) return;
    state.receivedBytes = Math.max(0, event.receivedBytes);
    state.totalBytes = Math.max(0, event.totalBytes);

    if (!record.accepted) {
      if (event.state === 'canceled' || event.state === 'completed') {
        binding.downloads.delete(event.guid);
        await this.cleanupDownloadFile(event.guid);
        await this.publishState(true).catch(() => undefined);
      }
      return;
    }

    if (state.totalBytes > MAX_BROWSER_DOWNLOAD_FILE_BYTES || state.receivedBytes > MAX_BROWSER_DOWNLOAD_FILE_BYTES) {
      record.accepted = false;
      await this.browserDownloadClient?.send('Browser.cancelDownload', { guid: event.guid }).catch(() => undefined);
      state.status = 'failed';
      if (binding.activeDownloadId === event.guid) binding.activeDownloadId = null;
      this.publishTransferError(new Error('Browser download file is too large.'));
      await this.publishState(true).catch(() => undefined);
      return;
    }

    if (event.state === 'canceled') {
      state.status = state.status === 'failed' ? 'failed' : 'canceled';
      if (binding.activeDownloadId === event.guid) binding.activeDownloadId = null;
      binding.downloads.delete(event.guid);
      await this.cleanupDownloadFile(event.guid);
      await this.publishState(true).catch(() => undefined);
      return;
    }
    if (event.state !== 'completed') {
      await this.publishState(false).catch(() => undefined);
      return;
    }

    if (binding.activeDownloadId === event.guid) binding.activeDownloadId = null;
    binding.downloads.delete(event.guid);
    try {
      const stagingDirectory = this.requireDownloadStagingDirectory();
      const sourcePath = await resolveCompletedBrowserDownloadSource(stagingDirectory, event.guid, event.filePath);
      const completed = await moveBrowserDownloadIntoWorkspace({
        context: this.context,
        sourcePath,
        stagingDirectory,
        suggestedFileName: record.fileName,
      });
      state.fileName = completed.fileName;
      state.receivedBytes = completed.size;
      state.totalBytes = completed.size;
      state.status = 'completed';
      state.workspacePath = completed.workspacePath;
      await this.audit('browser_view.download', { bytes: completed.size, files: 1 });
    } catch (error) {
      state.status = 'failed';
      this.publishTransferError(error);
      await this.cleanupDownloadFile(event.guid);
    }
    await this.publishState(true).catch(() => undefined);
  }

  private requireDownloadStagingDirectory(): string {
    if (!this.downloadStagingDirectory) throw new Error('Browser download staging is unavailable.');
    return this.downloadStagingDirectory;
  }

  private async cleanupDownloadFile(guid: string): Promise<void> {
    if (!this.downloadStagingDirectory) return;
    await cleanupBrowserDownloadStagingFile(this.downloadStagingDirectory, guid).catch(() => undefined);
  }

  private async releasePageTransfers(page: Page): Promise<void> {
    const binding = this.pageTransfers.get(page);
    if (!binding) return;
    this.pageTransfers.delete(page);
    for (const guid of binding.downloads.keys()) {
      await this.browserDownloadClient?.send('Browser.cancelDownload', { guid }).catch(() => undefined);
      await this.cleanupDownloadFile(guid);
    }
    binding.downloads.clear();
    await binding.pageClient.detach().catch(() => undefined);
  }

  async getState(): Promise<BrowserViewState> {
    return withBrowserRuntimeLock(this.context, async () => {
      const [tabs, page] = await Promise.all([
        getBrowserRuntimeTabs(this.context),
        ensurePage(this.context),
      ]);
      const control = getBrowserControlState(this.context);
      await this.ensurePageTransfers(page);
      const sensitiveInputFocused = await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLInputElement)) return false;
        const autocomplete = active.autocomplete.toLowerCase();
        return active.type === 'password'
          || autocomplete === 'current-password'
          || autocomplete === 'new-password'
          || autocomplete === 'one-time-code'
          || autocomplete.startsWith('cc-');
      }).catch(() => false);
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
        pendingFileChooser: this.pendingFileChooser
          ? {
            multiple: this.pendingFileChooser.chooser.isMultiple(),
            openedAt: this.pendingFileChooser.openedAt,
          }
          : null,
        downloads: Array.from(this.downloads.values()).slice(-MAX_VISIBLE_DOWNLOADS),
        sensitiveInputFocused,
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
      if (input.action === 'move') {
        await page.mouse.move(x, y);
      } else if (input.action === 'down') {
        await page.mouse.move(x, y);
        await page.mouse.down({ button });
      } else if (input.action === 'up') {
        await page.mouse.move(x, y);
        await page.mouse.up({ button });
      } else {
        await page.mouse.click(x, y, { button });
      }
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

  async uploadFiles(paths: unknown): Promise<void> {
    const pending = this.pendingFileChooser;
    if (!pending) throw new Error('A browser file chooser is required.');
    await withBrowserRuntimeLock(this.context, async () => {
      assertBrowserUserControl(this.context, this.claims.viewId);
      refreshBrowserControlLease(this.context, this.claims.viewId);
      const resolved = await resolveBrowserUploadFiles(
        this.context,
        paths,
        pending.chooser.isMultiple(),
      );
      await pending.chooser.accept(resolved.absolutePaths);
      if (this.pendingFileChooser === pending) this.pendingFileChooser = null;
      this.armFileChooser(pending.page);
      scheduleIdleClose(this.context);
      await this.audit('browser_view.upload', { bytes: resolved.totalBytes, files: resolved.absolutePaths.length });
    });
    await this.publishState(true);
  }

  async cancelFileChooser(): Promise<void> {
    const pending = this.pendingFileChooser;
    if (!pending) return;
    await withBrowserRuntimeLock(this.context, async () => {
      assertBrowserUserControl(this.context, this.claims.viewId);
      this.pendingFileChooser = null;
      await pending.chooser.cancel();
      this.armFileChooser(pending.page);
    });
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
      await this.ensurePageTransfers(page);
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
    const pending = this.pendingFileChooser;
    this.pendingFileChooser = null;
    if (pending) void pending.chooser.cancel().catch(() => undefined);
    const releases = Array.from(this.pageTransfers.keys()).map((page) => this.releasePageTransfers(page));
    void Promise.all(releases).finally(() => {
      void this.browserDownloadClient?.detach().catch(() => undefined);
      this.browserDownloadClient = null;
      this.downloadStagingDirectory = null;
    });
    void this.audit('browser_view.disconnect', { releasedControl: true });
  }
}
