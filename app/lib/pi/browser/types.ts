import type { KeyInput } from 'puppeteer-core';

export type BrowserAction =
  | 'help'
  | 'status'
  | 'start'
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
  activeUrl?: string | null;
  activeTitle?: string | null;
  idleCloseMs?: number;
  pendingDialog?: BrowserDialogDetails | null;
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
  profileDirExists: boolean;
  running: boolean;
  activeSessionCount: number;
  pageCount?: number;
  activeUrl?: string | null;
  activeTitle?: string | null;
  idleCloseMs: number;
  pendingDialog?: BrowserDialogDetails | null;
};
