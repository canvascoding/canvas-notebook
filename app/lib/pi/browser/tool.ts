import 'server-only';

import { type AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

import { runBrowserGatewayAction, type BrowserGatewayInput } from './gateway';

export function createBrowserGatewayTool(): AgentTool {
  return {
    name: 'browser',
    label: 'Controlling browser',
    description:
      'Controlled headless Chromium gateway. Use web_fetch first for ordinary web content. ' +
      'Use browser only for JavaScript-rendered pages, UI interaction, screenshots, login/session checks, or local app verification. ' +
      'Call action "help" for detailed browser safety or interaction guidance.',
    executionMode: 'sequential',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('help'),
        Type.Literal('status'),
        Type.Literal('start'),
        Type.Literal('navigate'),
        Type.Literal('observe'),
        Type.Literal('click'),
        Type.Literal('type'),
        Type.Literal('keypress'),
        Type.Literal('scroll'),
        Type.Literal('screenshot'),
        Type.Literal('extract_content'),
        Type.Literal('console_logs'),
        Type.Literal('close'),
      ], { description: 'Browser gateway action to run.' }),
      topic: Type.Optional(Type.String({ description: 'For help: overview, safety, or interaction.' })),
      url: Type.Optional(Type.String({ description: 'For navigate: absolute http(s) URL or about:blank.' })),
      target_id: Type.Optional(Type.String({ description: 'Target ID returned by observe. Prefer this for click/type/scroll.' })),
      selector: Type.Optional(Type.String({ description: 'Fallback CSS selector. Must resolve to exactly one visible element.' })),
      text: Type.Optional(Type.String({ description: 'For type: text to enter.' })),
      key: Type.Optional(Type.String({ description: 'For keypress: key name, e.g. Enter, Escape, ArrowDown.' })),
      wait_until: Type.Optional(Type.Union([
        Type.Literal('load'),
        Type.Literal('domcontentloaded'),
        Type.Literal('networkidle0'),
        Type.Literal('networkidle2'),
      ], { description: 'For navigate. Defaults to domcontentloaded.' })),
      timeout_ms: Type.Optional(Type.Number({ description: 'Navigation/action timeout in milliseconds. Max 60000.' })),
      max_elements: Type.Optional(Type.Number({ description: 'For observe or console_logs: maximum entries to return.' })),
      max_content_length: Type.Optional(Type.Number({ description: 'For extract_content: max characters, up to 50000.' })),
      scroll_x: Type.Optional(Type.Number({ description: 'For scroll: horizontal delta. Defaults to 0.' })),
      scroll_y: Type.Optional(Type.Number({ description: 'For scroll: vertical delta. Defaults to 600.' })),
      full_page: Type.Optional(Type.Boolean({ description: 'For screenshot: capture the full page instead of viewport.' })),
      return_image: Type.Optional(Type.Boolean({ description: 'For screenshot: include image bytes in the tool result. Defaults to false.' })),
      clear: Type.Optional(Type.Boolean({ description: 'For type: clear the existing value before typing. Defaults to true.' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      try {
        if (signal?.aborted) {
          throw new Error('Tool execution aborted.');
        }
        const result = await runBrowserGatewayAction(params as BrowserGatewayInput);
        return {
          content: [
            { type: 'text', text: result.text },
            ...(result.image ? [{ type: 'image' as const, data: result.image.data, mimeType: result.image.mimeType }] : []),
          ],
          details: result.details || {},
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown browser tool error';
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}
