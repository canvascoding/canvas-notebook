import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import { ToolCallPill, ToolBatchDisclosure } from '../app/components/canvas-agent-chat/ChatToolRunMessages';
import { mapPersistedChatMessage } from '../app/components/canvas-agent-chat/chatMessageMapping';
import { getToolDisplayInfo } from '../app/lib/pi/tool-display';
import { readIntegrationToolReceipt, type IntegrationToolReceipt } from '../app/lib/integration-tools/receipt';
import type { ChatMessage, PersistedChatMessage, ToolBatch } from '../app/lib/chat/types';

const receipt: IntegrationToolReceipt = { version: 1, action: 'call', source: 'composio',
  providerName: 'Canva', connectionName: 'Design team', toolName: 'Create design' };
assert.deepEqual(readIntegrationToolReceipt({ integrationReceipt: receipt }), receipt);
for (const invalid of [null, [], { ...receipt, version: 2 }, { ...receipt, action: 'execute' },
  { ...receipt, action: { toString: () => 'call' } }, { ...receipt, source: 'native' }, { ...receipt, target: 'accounts' },
  { ...receipt, profileId: 'SECRET' }, { ...receipt, connectionName: 'composio:v1:SECRET' },
  { ...receipt, providerName: 'Canva\nSECRET' }, { ...receipt, providerName: 'Canva\u202eSECRET' },
  { ...receipt, providerName: 'a'.repeat(257) }, { ...receipt, toolName: false }]) {
  assert.equal(readIntegrationToolReceipt({ integrationReceipt: invalid }), null);
}
assert.equal(getToolDisplayInfo('integrations', 'de', undefined, { action: 'search', target: 'providers' }).label, 'Integrationen suchen');
assert.equal(getToolDisplayInfo('integrations', 'en', {}, { action: 'describe' }).label, 'Inspect tool');
assert.equal(getToolDisplayInfo('integrations', 'en', undefined, { action: 'list', target: 'tools' }).label, 'List tools');
assert.equal(getToolDisplayInfo('integrations', 'en', { integrations: { action: 'call', providerName: 'SECRET' } },
  { action: 'call', providerName: 'SECRET', source: 'mcp' }).context, undefined, 'Unverified args and technical metadata never become provider labels');
assert.equal(getToolDisplayInfo('integrations', 'en', { integrationReceipt: { ...receipt, providerName: 'tool:v1:SECRET' } },
  { action: 'call' }).context, undefined);
assert.equal(getToolDisplayInfo('integrations', 'en', { integrationReceipt: receipt }).context, 'Composio · Canva · Design team');
const longMcpReceipt = { ...receipt, source: 'mcp' as const, providerName: `Canva ${'a'.repeat(240)}`, connectionName: 'Design server' };
assert.match(getToolDisplayInfo('integrations', 'de', { integrationReceipt: longMcpReceipt }).context!, /^MCP · Canva /u,
  'The source is the leading context label even when a long provider name is truncated in the UI');

function message(value: IntegrationToolReceipt): ChatMessage {
  return { id: 'integration-result', role: 'toolResult', content: 'Operation completed.', status: 'sent',
    toolCallId: 'integration-call', toolName: 'integrations', toolArgs: JSON.stringify({ action: value.action,
      toolRef: 'tool:v1:SECRET_TOOL_REF', schemaRef: 'schema:v1:SECRET_SCHEMA_REF', arguments: { title: 'Campaign' } }),
    piMessage: { role: 'toolResult', toolCallId: 'integration-call', toolName: 'integrations', timestamp: 1,
      content: [{ type: 'text', text: 'Operation completed.' }], details: { integrationReceipt: value,
        integrations: { action: value.action, providerRef: 'composio:v1:SECRET_PROVIDER_REF' } } } as unknown as ChatMessage['piMessage'] };
}

for (const locale of ['en', 'de'] as const) {
  const translated = locale === 'de' ? de : en;
  const render = (child: React.ReactNode) => renderToStaticMarkup(<NextIntlClientProvider locale={locale} timeZone="UTC" messages={translated}>{child}</NextIntlClientProvider>);
  const value = message(receipt);
  const pill = render(<ToolCallPill message={value} />);
  assert.match(pill, /Composio · Canva · Design team/u);
  assert.match(pill, locale === 'de' ? /Tool ausführen/u : /Run tool/u);
  assert.doesNotMatch(pill, /SECRET|composio:v1:|schema:v1:|tool:v1:/u, 'Collapsed receipts hide technical refs');
  const batch: ToolBatch = { key: 'integration-batch', anchorMessageId: 'integration-assistant', startedAt: 1, endedAt: 2,
    calls: [{ id: 'integration-call', toolName: 'integrations', toolArgs: value.toolArgs, message: value }] };
  const collapsed = render(<ToolBatchDisclosure batch={batch} expanded={false} onToggle={() => {}} />);
  assert.match(collapsed, /Composio · Canva · Design team/u);
  assert.doesNotMatch(collapsed, /SECRET/u);
  const expanded = render(<ToolBatchDisclosure batch={batch} expanded onToggle={() => {}} />);
  assert.match(expanded, /Composio · Canva · Design team/u);
  assert.doesNotMatch(expanded, /SECRET/u, 'Expanding the run keeps each tool body independently collapsed');
  const mcp = render(<ToolCallPill message={message({ ...receipt, source: 'mcp', connectionName: 'Design server' })} />);
  assert.match(mcp, /MCP · Canva · Design server/u);
  const persisted = mapPersistedChatMessage({ ...value.piMessage, id: 7 } as unknown as PersistedChatMessage, 'Stopped');
  assert.ok(persisted);
  const restored = render(<ToolCallPill message={persisted!} />);
  assert.match(restored, /Composio · Canva · Design team/u, 'Saved chat messages retain safe receipt labels');
}
assert.equal(getToolDisplayInfo('email', 'en').label, 'Used email gateway');
assert.equal(getToolDisplayInfo('mcp', 'de').label, 'MCP verwendet');
assert.equal(getToolDisplayInfo('composio', 'en').label, 'Used connected-app gateway');
console.log('integration-tool-receipt-ui-test: strict receipts, localized source/profile labels, collapsed refs and persisted chat rendering passed');
