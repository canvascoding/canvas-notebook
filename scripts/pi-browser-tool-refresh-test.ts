import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';

import { Value } from 'typebox/value';
import { getCurrentSystemPrompt } from '../node_modules/@earendil-works/pi-ai/dist/index.js';


async function main() {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === '@earendil-works/pi-ai') {
      return originalLoad(path.join(process.cwd(), 'node_modules/@earendil-works/pi-ai/dist/index.js'), parent, false);
    }
    if (request === 'server-only') {
      return {};
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const { replaceNextTurnContext } = await import('../app/lib/pi/next-turn-context');
    const { createBrowserGatewayTool } = await import('../app/lib/pi/browser/tool');
    const dormantBrowserTool = createBrowserGatewayTool({}, { mode: 'dormant' });
    const activeBrowserTool = createBrowserGatewayTool({}, { mode: 'active' });

    const nextTurn = replaceNextTurnContext({
      messages: [],
      tools: [dormantBrowserTool],
    }, {
      systemPrompt: 'active browser schema',
      tools: [activeBrowserTool],
    });

    assert.ok(nextTurn.context, 'the next agent turn must receive a replacement context');
    assert.equal(getCurrentSystemPrompt(nextTurn.context.messages), 'active browser schema');
    assert.equal(nextTurn.context.tools?.[0], activeBrowserTool);

    const activeSchema = activeBrowserTool.parameters;
    assert.equal(Value.Check(activeSchema, { action: 'observe' }), true);
    assert.equal(Value.Check(activeSchema, { action: 'extract_content' }), true);
    assert.equal(Value.Check(activeSchema, { action: 'screenshot' }), true);
    assert.equal(Value.Check(activeSchema, { action: 'evaluate', script: 'document.title' }), true);
    assert.equal(Value.Check(activeSchema, { action: 'scroll', scroll_y: 500 }), true);
    assert.equal(Value.Check(dormantBrowserTool.parameters, { action: 'extract_content' }), false);
    assert.equal(Value.Check(activeSchema, { action: 'read' }), false);
    assert.equal(Value.Check(activeSchema, { action: 'inspect' }), false);

    const normalizedScroll = activeBrowserTool.prepareArguments?.({
      action: 'scroll',
      scrollY: 500,
    }) as Record<string, unknown>;
    assert.equal(normalizedScroll.scroll_y, 500);

    console.log('PI browser tool refresh test passed');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

void main();
