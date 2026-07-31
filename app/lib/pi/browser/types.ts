import type { KeyInput } from 'puppeteer-core';

export type BrowserAction =
  | 'help'
  | 'status'
  | 'start'
  | 'list_tabs'
  | 'select_tab'
  | 'new_tab'
  | 'close_tab'
  | 'navigate'
  | 'observe'
  | 'click'
  | 'type'
  | 'keypress'
  | 'scroll'
  | 'screenshot'
  | 'extract_content'
  | 'evaluate'
  | 'dialog_status'
  | 'accept_dialog'
  | 'dismiss_dialog'
  | 'console_logs'
  | 'close';

export type BrowserGatewayInput = {
  action?: BrowserAction | 'eval';
  topic?: string;
  url?: string;
  target_id?: string;
  selector?: string;
  text?: string;
  key?: KeyInput | string;
  script?: string;
  expression?: string;
  code?: string;
  wait_until?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
  timeout_ms?: number;
  max_elements?: number;
  max_content_length?: number;
  scroll_x?: number;
  scroll_y?: number;
  full_page?: boolean;
  return_image?: boolean;
  clear?: boolean;
  mutates?: boolean;
  prompt_text?: string;
  tab_id?: string;
};

export type BrowserGatewayOutput = {
  text: string;
  details?: Record<string, unknown>;
  image?: {
    data: string;
    mimeType: string;
  };
};

export type ObservedTarget = {
  targetId: string;
  tag: string;
  role: string | null;
  name: string | null;
  text: string | null;
  ariaLabel: string | null;
  placeholder: string | null;
  href: string | null;
  value: string | null;
  testId: string | null;
  type: string | null;
  disabled: boolean;
  checked: boolean | null;
  selected: boolean | null;
  rect: { x: number; y: number; width: number; height: number };
  candidates: string[];
};

export type BrowserObservation = {
  title: string;
  url: string;
  targets: ObservedTarget[];
};

export type ConsoleEntry = {
  level: string;
  text: string;
  location?: string;
  timestamp: string;
};

export type BrowserStatusDetails = {
  running: boolean;
  pageCount?: number;
  activeTabId?: string | null;
  activeUrl?: string | null;
  activeTitle?: string | null;
  idleCloseMs?: number;
  pendingDialog?: BrowserDialogDetails | null;
  tabs?: BrowserRuntimeTab[];
};

export type BrowserRuntimeTab = {
  id: string;
  title: string;
  url: string;
  active: boolean;
};

export type BrowserViewControlMode = 'view' | 'agent' | 'user';

export type BrowserSessionSnapshot = {
  revision: number;
  running: boolean;
  controlMode: BrowserViewControlMode;
  activeTabId: string | null;
  activeTitle: string | null;
  activeUrl: string | null;
  tabCount: number;
  tabs: BrowserRuntimeTab[];
  hasPendingDialog: boolean;
};

export type BrowserSessionSnapshotInput = Omit<BrowserSessionSnapshot, 'revision'>;

export type BrowserViewNavigationAction =
  | 'back'
  | 'forward'
  | 'reload'
  | 'stop'
  | 'new_tab'
  | 'close_tab';

export type BrowserViewErrorCode =
  | 'CAPACITY_EXHAUSTED'
  | 'CAPTURE_FAILED'
  | 'CONNECTION_FAILED'
  | 'CONNECTION_LOST'
  | 'CONNECTION_TIMEOUT'
  | 'CONTROL_CONFLICT'
  | 'DOWNLOAD_FAILED'
  | 'DOWNLOAD_TOO_LARGE'
  | 'FILE_ACCESS_DENIED'
  | 'FILE_CHOOSER_REQUIRED'
  | 'FILE_UPLOAD_FAILED'
  | 'FORBIDDEN'
  | 'INVALID_MESSAGE'
  | 'MESSAGE_TOO_LARGE'
  | 'NAVIGATION_BLOCKED'
  | 'NAVIGATION_FAILED'
  | 'OPERATION_FAILED'
  | 'PAGE_CRASHED'
  | 'RATE_LIMITED'
  | 'RESOURCE_UNAVAILABLE'
  | 'SESSION_SCOPE_CHANGED'
  | 'TICKET_EXPIRED'
  | 'UNAUTHORIZED'
  | 'VIEW_CONFLICT';

export type BrowserViewFailure = {
  code: BrowserViewErrorCode;
  error: string;
  retryable: boolean;
  fatal: boolean;
};

export type BrowserViewFileChooser = {
  multiple: boolean;
  openedAt: string;
};

export type BrowserViewDownload = {
  id: string;
  fileName: string;
  status: 'in_progress' | 'completed' | 'canceled' | 'failed';
  receivedBytes: number;
  totalBytes: number;
  workspacePath: string | null;
};

export type BrowserViewResourceBudget = {
  allowed: boolean;
  effectiveMemoryMb: number;
  availableMemoryMb: number;
  fps: number;
  viewport: { width: number; height: number };
  jpegQuality: number;
  maxConcurrentViews: number;
  reason: string | null;
};

export type BrowserViewState = {
  viewId: string;
  agentId: string;
  agentSessionId: string;
  workspaceId: string;
  mode: BrowserViewControlMode;
  controlOwnerViewId: string | null;
  leaseExpiresAt: string | null;
  activeTabId: string | null;
  title: string;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  tabs: BrowserRuntimeTab[];
  pendingDialog: BrowserDialogDetails | null;
  pendingFileChooser: BrowserViewFileChooser | null;
  downloads: BrowserViewDownload[];
  sensitiveInputFocused: boolean;
  viewport: { width: number; height: number };
  resourceBudget: BrowserViewResourceBudget;
};

export type BrowserDialogDetails = {
  type: string;
  message: string;
  defaultValue: string;
  openedAt: string;
};

export type BrowserProfileScope = 'agent' | 'session' | 'user';

export type BrowserProfileDetails = {
  scope: BrowserProfileScope;
  profileKey: string;
  sessionKey: string;
  userDataDir: string;
  workspaceId?: string | null;
  workspaceType?: string | null;
  organizationId?: string | null;
  profileDirExists: boolean;
  running: boolean;
  sessionRunning: boolean;
  activeSessionCount: number;
  pageCount?: number;
  activeUrl?: string | null;
  activeTitle?: string | null;
  idleCloseMs: number;
  pendingDialog?: BrowserDialogDetails | null;
};
