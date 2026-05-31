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
  | 'console_logs'
  | 'close';

export type BrowserGatewayInput = {
  action?: BrowserAction;
  topic?: string;
  url?: string;
  target_id?: string;
  selector?: string;
  text?: string;
  key?: KeyInput | string;
  wait_until?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
  timeout_ms?: number;
  max_elements?: number;
  max_content_length?: number;
  scroll_x?: number;
  scroll_y?: number;
  full_page?: boolean;
  return_image?: boolean;
  clear?: boolean;
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
  text: string | null;
  ariaLabel: string | null;
  placeholder: string | null;
  href: string | null;
  value: string | null;
  testId: string | null;
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
};
