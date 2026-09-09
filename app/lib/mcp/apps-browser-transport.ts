import { JSONRPCMessageSchema } from '@modelcontextprotocol/core';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/** AppBridge validates method schemas after this boundary authenticates the sending frame. */
export class McpAppFrameTransport implements Transport {
  onmessage?: Transport['onmessage'];
  onerror?: Transport['onerror'];
  onclose?: Transport['onclose'];
  private active = false;
  constructor(private target: Window, private targetOrigin: string, private host: Window = window) {}

  private receive = (event: MessageEvent) => {
    if (!this.active || event.source !== this.target || event.origin !== this.targetOrigin) return;
    try {
      if (JSON.stringify(event.data).length > MAX_MESSAGE_BYTES) return;
      const parsed = JSONRPCMessageSchema.safeParse(event.data);
      if (parsed.success) this.onmessage?.(parsed.data);
    } catch { /* Discard invalid untrusted messages without logging their contents. */ }
  };

  async start(): Promise<void> {
    if (this.active) throw new Error('MCP app transport already started.');
    this.active = true;
    this.host.addEventListener('message', this.receive);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.active) throw new Error('MCP app transport is closed.');
    if (JSON.stringify(message).length > MAX_MESSAGE_BYTES) throw new Error('MCP app message is too large.');
    this.target.postMessage(message, this.targetOrigin);
  }

  async close(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.host.removeEventListener('message', this.receive);
    this.onclose?.();
  }
}
