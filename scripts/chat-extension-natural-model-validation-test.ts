import assert from 'node:assert/strict';
import { assertNaturalModelToolResults } from '../tests/helpers/natural-model-tool-validation';

// Pure transcript-classifier regression only: no model, SQL, source or provider.
type Messages = Parameters<typeof assertNaturalModelToolResults>[0];
type FixtureMessage = Omit<Messages[number], 'content'> & { content?: { type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }[] };
const query = 'Messekampagne Freigabekriterien Eskalation Marketing';
const invalidArgs = { action: 'search_canvas_extensions', query };
const diagnostic = `Validation failed for tool "canvas_extensions":\n  - action: must be equal to constant\n  - action: must be equal to constant\n  - action: must be equal to constant\n  - action: must match a schema in anyOf\n\nReceived arguments:\n${JSON.stringify(invalidArgs, null, 2)}`;
const recovered = (): FixtureMessage[] => [
  { role: 'assistant', content: [{ type: 'toolCall', id: 'invalid', name: 'canvas_extensions', arguments: { ...invalidArgs } }] },
  { role: 'toolResult', toolName: 'canvas_extensions', toolCallId: 'invalid', isError: true, details: {}, content: [{ type: 'text', text: diagnostic }] },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'describe', name: 'canvas_extensions', arguments: { action: 'describe', operation: 'search_canvas_extensions' } }] },
  { role: 'toolResult', toolName: 'canvas_extensions', toolCallId: 'describe', details: { gateway: 'canvas_extensions', action: 'describe', operation: 'search_canvas_extensions', schema: { type: 'object' } } },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'execute', name: 'canvas_extensions', arguments: { action: 'call', operation: 'search_canvas_extensions', arguments: { query, limit: 10, types: ['skill', 'plugin'] } } }] },
  { role: 'toolResult', toolName: 'canvas_extensions', toolCallId: 'execute', details: { gateway: 'canvas_extensions', action: 'call', operation: 'search_canvas_extensions', extensionDiscovery: { items: [] } } },
];
let count = 0;
const check = (name: string, run: () => void) => { run(); count++; console.log(`PASS ${name}`); };
const reject = (messages: Messages) => assert.throws(() => assertNaturalModelToolResults(messages), /disallowed or unrecovered tool error/u);
check('successful transcripts need no exception', () => assert.equal(assertNaturalModelToolResults(recovered().slice(2)), 0));
check('one exact SDK outer-action enum error must have a later paired describe and same-query metadata call', () => assert.equal(assertNaturalModelToolResults(recovered()), 1));
check('no recovery is rejected', () => reject(recovered().slice(0, 2)));
check('two schema errors are rejected even when the later recovery succeeds', () => { const value = recovered(); reject([...value.slice(0, 2), ...value]); });
check('read errors cannot qualify', () => { const value = recovered(); value[0]!.content![0]!.name = 'read'; value[1]!.toolName = 'read'; reject(value); });
check('provider, ACL and unknown-outcome errors remain rejected', () => {
  for (const error of ['provider_unavailable', 'AGENT_EXTENSION_CONTEXT_DENIED', 'outcome_unknown']) {
    reject([...recovered(), { role: 'toolResult', toolName: 'integrations', toolCallId: 'business', isError: true, details: { integrationError: { code: error } } }]);
  }
});
check('error details must be empty and generic prefix matches are rejected', () => {
  const details = recovered(); details[1]!.details = { error: 'provider_unavailable' }; reject(details);
  const generic = recovered(); generic[1]!.content![0]!.text = 'Validation failed for tool "canvas_extensions": provider_unavailable'; reject(generic);
});
check('invalid integrations params and extra outer-action params are rejected', () => {
  const other = recovered(); other[0]!.content![0]!.name = 'integrations'; other[1]!.toolName = 'integrations'; reject(other);
  const extra = recovered(); Object.assign(extra[0]!.content![0]!.arguments!, { operation: 'search_canvas_extensions' }); reject(extra);
});
check('successful results must be paired and ordered after describe', () => {
  const wrongId = recovered(); wrongId[3]!.toolCallId = 'other'; reject(wrongId);
  const order = recovered(); reject([...order.slice(0, 2), ...order.slice(4), ...order.slice(2, 4)]);
});
check('recovery cannot switch operation, query or gateway', () => {
  const operation = recovered(); operation[2]!.content![0]!.arguments!.operation = 'list_canvas_package_store'; reject(operation);
  const changed = recovered(); Object.assign(changed[4]!.content![0]!.arguments!.arguments as Record<string, unknown>, { query: 'another query' }); reject(changed);
  const gateway = recovered(); gateway[5]!.details!.gateway = 'composio'; reject(gateway);
});
check('a failed metadata call is not recovery', () => { const value = recovered(); Object.assign(value[5]!, { isError: true, details: { error: 'denied' } }); reject(value); });
console.log(`PASS ${count} natural-model pre-execution-validation groups (pure classification only)`);
