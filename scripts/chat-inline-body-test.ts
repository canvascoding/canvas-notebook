import assert from 'node:assert/strict';
import Module from 'node:module';
import vm from 'node:vm';
import { build } from 'esbuild';
import {
  CHAT_BODY_MAX_BYTES, assertChatBodyContent, assertChatBodySelection, canonicalChatBodyIntent,
  chatBodyV1Schema, deriveChatBodySelection, parseChatBody, projectChatBodyText,
  type ChatBodyV1, type ChatReferenceBundleV1,
} from '../app/lib/chat/chat-body-contracts';
import type { CanonicalMessageIntent } from '../app/lib/chat/durable-message-contracts';
import type { ExtensionPackageConnection, ExtensionSelectionEntry } from '../app/lib/capabilities/extensions/contracts';
import { createPersonalComposioAccountReference } from '../app/lib/composio/composio-shared-account-reference';
import { createIntegrationProviderRef } from '../app/lib/integration-tools/references';

// Actual public/private syntax parsers, crypto and a browser-target bundle. This
// creates no SQL state, package/source proof, runtime or provider request.
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const pin = { resourceRef: `canvas-resource:${id(1)}`, publishedRevisionRef: `canvas-package-revision:${id(2)}`, checksum: 'a'.repeat(64) };
const plugin: ExtensionSelectionEntry = { selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null };
const mcp = { selection: { kind: 'mcp' as const, source: 'mcp' as const,
  target: { kind: 'shared' as const, connectionRef: `canvas-connection:${id(3)}`, bindingRevision: 7 } }, requirement: 'required' as const, toolCap: ['READ'] };
const account = { selection: { kind: 'composio' as const, source: 'composio' as const, toolkit: 'canva',
  target: { kind: 'personal' as const, profileId: 'profile-alice', accountBinding: 'account' as const,
    accountId: 'account-B', connectionRef: 'composio-personal:profile-alice:account-B' } }, requirement: 'optional' as const, toolCap: ['CREATE'] };
const mapping: ExtensionPackageConnection = { package: pin, declarationPath: '.canvas-plugin/plugin.json', capabilityId: 'read',
  alternativeKey: 'mcp:source', connectionSelection: mcp.selection };
const bundle = (primary: ExtensionSelectionEntry = mcp, caption = 'MCP', key = 'bundle-a'): ChatReferenceBundleV1 =>
  ({ id: key, caption, primary: structuredClone(primary), supporting: [], packageConnections: [] });
const body = (value: ChatReferenceBundleV1 = bundle()): ChatBodyV1 => ({ version: 1,
  parts: [{ type: 'text', text: 'Bitte ' }, { type: 'extension_reference', occurrenceId: 'occurrence-a', bundleId: value.id }, { type: 'text', text: ' nutzen.' }], bundles: [value] });
const packageBody = (): ChatBodyV1 => body({ ...bundle(plugin, 'Plugin'), supporting: [structuredClone(mcp)], packageConnections: [structuredClone(mapping)] });

async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  let authorityCalls = 0, cases = 0;
  // accepted-turn-selection co-locates its genuine private parser with runtime
  // imports. Unused authority imports are hard failures, never success mocks.
  loader._load = (name, parent, isMain) => {
    if (parent?.filename.endsWith('/accepted-turn-selection.ts') && [
      './standalone-preparation', '@/app/lib/agents/actor-context', '@/app/lib/pi/session-workspace-context',
    ].includes(name)) {
      const forbidden = () => { authorityCalls++; throw new Error('Inline syntax tests cannot prepare source authority.'); };
      return { prepareStandaloneExtensionSelection: forbidden, revalidatePreparedStandaloneExtensionSelection: forbidden,
        getPreparedStandaloneExtensionBinding: forbidden, withRevalidatedStandaloneTurnSelectionOnConnection: forbidden,
        resolveVerifiedAgentActorContextOnConnection: forbidden, readStoredAgentWorkspaceOnConnection: forbidden,
        workspaceToAgentExecutionContext: forbidden };
    }
    return originalLoad(name, parent, isMain);
  };
  const previousSecret = process.env.BETTER_AUTH_SECRET;
  try {
    const codec = await import('../app/lib/chat/durable-message-contracts');
    const { canonicalAcceptedMessageIntentHash: hash, canonicalMessageIntentHash: legacyHash,
      captureChatMessageAdmissionRequest: capture, parseCanonicalMessageIntent: parseIntent,
      parseStoredAcceptedChatMessage: parseStored } = codec;
    const check = (name: string, run: () => void) => { run(); cases++; console.log(`PASS ${name}`); };
    const rejects = (value: unknown) => {
      assert.equal(chatBodyV1Schema.safeParse(value).success, false);
      assert.throws(() => parseChatBody(value));
    };
    const intent = (value: ChatBodyV1, extra: Partial<CanonicalMessageIntent> = {}): CanonicalMessageIntent =>
      ({ content: projectChatBodyText(value), context: {}, mode: 'message', selection: deriveChatBodySelection(value), body: value, ...extra });

    check('five independently captured committed V1 hash goldens and absent body bytes', () => {
      // Captured by executing git show 8520d3f6e:.../durable-message-contracts.ts,
      // before inline changes; expected hashes never use the new implementation.
      const goldens: Array<{ value: CanonicalMessageIntent; expected: string }> = [
        { value: { content: '  Alt\n🙂 e\u0301  ', context: null, mode: 'message', selection: null },
          expected: '18c28bdc2c369534c65634e80882bea762eee209419186e6868c17bc1565e0fe' },
        { value: { content: [{ type: 'text', text: '  Original\nText 🎨 e\u0301  ', textSignature: 'opaque-original-signature' },
          { type: 'image', data: '/api/files/uploads/upload-a', mimeType: 'image/png' }, { type: 'text', text: 'Nachtrag' }],
        context: { workspace: { workspaceId: 'workspace-a', workspaceType: 'personal', workspaceName: 'Alt', canWrite: true, canDelete: false, canShare: false },
          currentTime: '2026-10-14T12:00:00Z', userTimeZone: 'Europe/Berlin', planningMode: true, activeFilePath: 'notes/a.md' }, mode: 'steer', selection: null },
        expected: '86bf9633731792642fe75150774c7ced3185795cda58bef6da6e8c1b989ab4f4' },
        { value: { content: 'Canva', context: {}, mode: 'message', selection: { version: 1, origin: 'turn_reference', selections: [account] } },
          expected: '1df97334c7751f706fe68421bc27aabfb657af2092f80cd8ea7a869048552503' },
        { value: { content: 'Plugin + MCP', context: { channelId: 'app', activeFilePath: 'x' }, mode: 'message',
          selection: { version: 1, origin: 'turn_reference', selections: [plugin, mcp], packageConnections: [mapping] } },
        expected: '38b2766ad24cf6c77c01a403539e8af84592855662050190b58ac8e335800af5' },
        { value: { content: [], context: null, mode: 'message', selection: { version: 1, origin: 'turn_reference', selections: [], packageConnections: [] } },
          expected: '6ad61faf501ba84afc65ec18c48c3f0098b1e56bd8d46591fb9800262f4526ab' },
      ];
      for (const golden of goldens) {
        assert.equal(legacyHash(golden.value), golden.expected);
        assert.equal(hash(golden.value), golden.expected);
        const parsed = parseIntent(golden.value);
        assert.equal(Object.hasOwn(parsed, 'body'), false);
        assert.equal(JSON.stringify(parsed).includes('"body"'), false);
      }
      const request = capture({ userId: 'alice', sessionId: 'session-a', clientMessageId: 'old-message', message: { role: 'user', content: 'old', timestamp: 1 } });
      assert.equal(Object.hasOwn(request, 'body'), false);
    });

    const browserBundle = await build({ stdin: { contents: "export { parseChatBody, deriveChatBodySelection, projectChatBodyText } from './app/lib/chat/chat-body-contracts';",
      resolveDir: process.cwd(), sourcefile: 'inline-body-browser-entry.ts' }, bundle: true, write: false, platform: 'browser', format: 'iife',
    globalName: 'InlineBody', metafile: true, logLevel: 'silent' });
    const browserInputs = Object.keys(browserBundle.metafile!.inputs);
    assert(browserInputs.some(input => input.endsWith('app/lib/chat/chat-body-contracts.ts')));
    assert(!browserInputs.some(input => /(?:server-only|accepted-turn-selection|durable-message-contracts|app\/lib\/db\/)/u.test(input)));
    const browserWorld = vm.createContext({ TextEncoder });
    vm.runInContext(browserBundle.outputFiles[0].text, browserWorld);
    const browserResult = vm.runInContext(`(() => { const b=InlineBody.parseChatBody(JSON.parse(${JSON.stringify(JSON.stringify(body()))}));
      return JSON.stringify({text:InlineBody.projectChatBodyText(b),selection:InlineBody.deriveChatBodySelection(b),nodeGlobals:[typeof process,typeof require,typeof Buffer]}); })()`, browserWorld);
    check('browser bundle imports real schema and runs with no Node globals', () => {
      assert.deepEqual(JSON.parse(browserResult), { text: projectChatBodyText(body()), selection: deriveChatBodySelection(body()), nodeGlobals: ['undefined', 'undefined', 'undefined'] });
    });

    check('precise all-four-kind identities, Unicode and immutable clone', () => {
      const values: ExtensionSelectionEntry[] = [plugin, { selection: { kind: 'skill', package: pin, origin: 'plugin_child', relativeRoot: '' }, requirement: 'required', toolCap: null }, mcp, account];
      const value: ChatBodyV1 = { version: 1, parts: values.flatMap((_, index) => [{ type: 'text' as const, text: ` ${index}🙂e\u0301 ` },
        { type: 'extension_reference' as const, occurrenceId: `occurrence-${index}`, bundleId: `bundle-${index}` }]),
      bundles: values.map((entry, index) => bundle(entry, `Name ${index}`, `bundle-${index}`)) };
      const parsed = parseChatBody(value), selection = deriveChatBodySelection(parsed);
      assert.deepEqual(selection?.selections, values);
      assert(projectChatBodyText(parsed).includes('🙂e\u0301'));
      assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.parts) && Object.isFrozen(parsed.bundles[0].primary.selection));
      value.bundles[0].caption = 'later';
      assert.equal(parsed.bundles[0].caption, 'Name 0');
      assertChatBodyContent(parsed, projectChatBodyText(parsed)); assertChatBodySelection(parsed, selection);
      assert.equal(deriveChatBodySelection({ version: 1, parts: [{ type: 'text', text: '/Canva' }], bundles: [] }), null);
      assert.equal(deriveChatBodySelection({ version: 1, parts: [], bundles: [] }), null);
      const referenceOnly = body(); referenceOnly.parts = [referenceOnly.parts[1]];
      assert.equal(projectChatBodyText(referenceOnly), 'MCP');
    });

    check('IDs, captions, table order and equivalent text segmentation are presentation only', () => {
      const first = body(), next = structuredClone(first);
      next.bundles[0].id = 'renamed'; next.bundles[0].caption = 'Ein anderer sichtbarer Name';
      next.parts[1] = { type: 'extension_reference', occurrenceId: 'new-occurrence', bundleId: 'renamed' };
      next.parts.unshift({ type: 'text', text: '' }); next.parts.splice(1, 1, { type: 'text', text: 'Bit' }, { type: 'text', text: 'te ' });
      assert.deepEqual(canonicalChatBodyIntent(next), canonicalChatBodyIntent(first));
      assert.equal(hash(intent(first)), hash(intent(next)), 'Matching displayed content changes with a caption, but is not intent identity');
      const two: ChatBodyV1 = { version: 1, parts: [first.parts[1], { type: 'extension_reference', occurrenceId: 'second', bundleId: 'account' }],
        bundles: [bundle(mcp), bundle(account, 'Canva', 'account')] };
      const reverse = structuredClone(two); reverse.bundles.reverse();
      assert.equal(hash(intent(two)), hash(intent(reverse)));
      assert.notEqual(hash(intent(first)), legacyHash({ content: projectChatBodyText(first), context: {}, mode: 'message', selection: deriveChatBodySelection(first) }));
      assert.throws(() => legacyHash(intent(first)), /accepted-message intent hash/u);
    });

    check('text, placement, account, caps, requirements, message mode and exact package pin remain intent', () => {
      const base = body(bundle(account, 'Canva')), original = hash(intent(base));
      const variants: ChatBodyV1[] = [];
      const text = structuredClone(base); text.parts[0] = { type: 'text', text: 'Please ' }; variants.push(text);
      const position = structuredClone(base); position.parts = [position.parts[1], position.parts[0], position.parts[2]]; variants.push(position);
      const otherAccount = structuredClone(base); const entry = otherAccount.bundles[0].primary;
      assert(entry.selection.kind === 'composio' && entry.selection.target.kind === 'personal' && entry.selection.target.accountBinding === 'account');
      entry.selection.target.accountId = 'account-A'; entry.selection.target.connectionRef = 'composio-personal:profile-alice:account-A'; variants.push(otherAccount);
      const cap = structuredClone(base); cap.bundles[0].primary.toolCap = []; variants.push(cap);
      const requirement = structuredClone(base); requirement.bundles[0].primary.requirement = 'required'; variants.push(requirement);
      for (const changed of variants) assert.notEqual(hash(intent(changed)), original);
      assert.notEqual(hash(intent(base, { mode: 'steer' })), original);
      const held = body(bundle(plugin)), heldChanged = structuredClone(held);
      const selected = heldChanged.bundles[0].primary.selection;
      assert(selected.kind === 'plugin'); selected.package.publishedRevisionRef = `canvas-package-revision:${id(8)}`;
      assert.notEqual(hash(intent(held)), hash(intent(heldChanged)));
      selected.package = { ...pin, checksum: 'b'.repeat(64) };
      assert.notEqual(hash(intent(held)), hash(intent(heldChanged)));
      const composed = body(); composed.parts[0] = { type: 'text', text: 'é' };
      const decomposed = structuredClone(composed); decomposed.parts[0] = { type: 'text', text: 'e\u0301' };
      assert.notEqual(hash(intent(composed)), hash(intent(decomposed)), 'Unicode is never silently normalized');
    });

    check('no orphan/hidden references, private targets, receipts, icons or unknown fields', () => {
      rejects({ ...body(), bundles: [] });
      rejects({ ...body(), parts: [] });
      rejects({ ...body(), bundles: [...body().bundles, bundle(account, 'Hidden', 'hidden')] });
      rejects({ ...body(), parts: [...body().parts, body().parts[1]] });
      rejects({ ...body(), bundles: [...body().bundles, body().bundles[0]] });
      rejects({ ...body(), unknown: true });
      for (const patch of [{ icon: 'https://example.invalid/logo.svg' }, { logoUrl: 'https://example.invalid/logo.svg' },
        { accountSelectionRef: `cmp_personal_account_${'x'.repeat(48)}` }, { retainedBindingRef: `agent-extension-retain:v1:${'a'.repeat(64)}` }]) {
        rejects({ ...body(), bundles: [{ ...bundle(), ...patch }] });
        rejects({ ...body(), bundles: [{ ...bundle(), primary: { ...mcp, ...patch } }] });
      }
      rejects(body({ ...bundle(), primary: { ...mcp, selection: { ...mcp.selection, target: { ...mcp.selection.target, authorization: 'private' } } } } as unknown as ChatReferenceBundleV1));
      rejects({ ...body(), version: 2 }); rejects(null);
      rejects({ ...body(), parts: [{ type: 'extension_reference', occurrenceId: 'bad\n', bundleId: 'bundle-a' }] });
      assert.throws(() => parseIntent({ ...intent(body()), body: null }));
      assert.throws(() => parseIntent({ ...intent(body()), body: undefined }));
    });

    check('plugin dependency graph, exact pins, duplicate deduplication and deletion reachability', () => {
      const value = packageBody(), selected = deriveChatBodySelection(value);
      assert.deepEqual(selected?.selections, [plugin, mcp]); assert.deepEqual(selected?.packageConnections, [mapping]);
      const missingSupport = structuredClone(value); missingSupport.bundles[0].supporting = []; rejects(missingSupport);
      const missingMapping = structuredClone(value); missingMapping.bundles[0].packageConnections = []; rejects(missingMapping);
      const otherPin = structuredClone(value); otherPin.bundles[0].packageConnections[0].package.checksum = 'b'.repeat(64); rejects(otherPin);
      const conflictingSlot = structuredClone(value);
      conflictingSlot.bundles[0].packageConnections.push({ ...mapping, alternativeKey: 'mcp:other' }); rejects(conflictingSlot);
      const standalone = body(); standalone.bundles[0].supporting = [mcp]; standalone.bundles[0].packageConnections = [mapping]; rejects(standalone);
      const duplicates = structuredClone(value); duplicates.parts.push({ type: 'extension_reference', occurrenceId: 'again', bundleId: 'bundle-a' });
      duplicates.bundles[0].supporting.push(structuredClone(mcp)); duplicates.bundles[0].packageConnections.push(structuredClone(mapping));
      assert.deepEqual(deriveChatBodySelection(duplicates), selected);
      const conflicting = structuredClone(value); conflicting.bundles.push(bundle({ ...mcp, toolCap: [] }, 'same target', 'other'));
      conflicting.parts.push({ type: 'extension_reference', occurrenceId: 'other', bundleId: 'other' }); rejects(conflicting);
      const independent = structuredClone(value); independent.bundles.push(bundle(mcp, 'Explicit MCP', 'independent'));
      independent.parts.push({ type: 'extension_reference', occurrenceId: 'independent', bundleId: 'independent' });
      assert.equal(deriveChatBodySelection(independent)?.selections.length, 2);
      const deleted: ChatBodyV1 = { version: 1, parts: [independent.parts.at(-1)!], bundles: [independent.bundles[1]] };
      assert.deepEqual(deriveChatBodySelection(deleted)?.selections, [mcp]);
      assert.equal(deriveChatBodySelection(deleted)?.packageConnections, undefined, 'Deleting the plugin removes its mappings while explicit MCP remains');
      const secondPin = { ...pin, resourceRef: `canvas-resource:${id(9)}`, publishedRevisionRef: `canvas-package-revision:${id(10)}` };
      const secondPlugin: ExtensionSelectionEntry = { ...plugin, selection: { kind: 'plugin', package: secondPin, skillSelection: { kind: 'all' } } };
      const secondBundle = { ...bundle(secondPlugin, 'Second plugin', 'second-plugin'), supporting: [mcp], packageConnections: [{ ...mapping, package: secondPin }] };
      const bothPlugins: ChatBodyV1 = { version: 1, parts: [value.parts[1], { type: 'extension_reference', occurrenceId: 'second-plugin', bundleId: secondBundle.id }],
        bundles: [value.bundles[0], secondBundle] };
      assert.equal(deriveChatBodySelection(bothPlugins)?.selections.length, 3);
      const secondOnly: ChatBodyV1 = { version: 1, parts: [bothPlugins.parts[1]], bundles: [secondBundle] };
      assert.deepEqual(deriveChatBodySelection(secondOnly)?.selections, [secondPlugin, mcp], 'A shared dependency remains reachable through the surviving plugin');
      assert.deepEqual(deriveChatBodySelection(secondOnly)?.packageConnections, secondBundle.packageConnections);
      const empty: ChatBodyV1 = { version: 1, parts: [], bundles: [] }; assert.equal(deriveChatBodySelection(empty), null);
      assert.throws(() => assertChatBodySelection(value, { version: 1, origin: 'turn_reference', selections: [plugin] }));
      assert.throws(() => assertChatBodySelection(empty, selected));
      const tooMany: ChatBodyV1 = { version: 1, parts: [], bundles: [] };
      for (let index = 0; index < 6; index++) {
        const one = bundle({ ...mcp, selection: { ...mcp.selection, target: { ...mcp.selection.target, connectionRef: `canvas-connection:${id(index + 30)}` } } }, 'MCP', `b-${index}`);
        tooMany.bundles.push(one); tooMany.parts.push({ type: 'extension_reference', occurrenceId: `o-${index}`, bundleId: one.id });
      }
      rejects(tooMany);
      const supported: ChatBodyV1 = body({ ...bundle(plugin, 'Plugin'), supporting: [], packageConnections: [] });
      for (let index = 0; index < 5; index++) {
        const support = { ...mcp, selection: { ...mcp.selection, target: { ...mcp.selection.target, connectionRef: `canvas-connection:${id(index + 50)}` } } };
        supported.bundles[0].supporting.push(support);
        supported.bundles[0].packageConnections.push({ ...mapping, capabilityId: `cap-${index}`, connectionSelection: support.selection });
      }
      rejects(supported);
      supported.bundles[0].supporting.pop(); supported.bundles[0].packageConnections.pop();
      assert.equal(deriveChatBodySelection(supported)?.selections.length, 5, 'The limit counts the plugin and all four support entries');
    });

    check('content coupling preserves string and every additional attachment/signature byte', () => {
      const value = body(), display = projectChatBodyText(value);
      const blocks: [{ type: 'text'; text: string; textSignature: string }, { type: 'image'; data: string; mimeType: string }, { type: 'text'; text: string }] =
        [{ type: 'text', text: display, textSignature: 'signature-a' },
          { type: 'image', data: '/api/files/uploads/ä%20a', mimeType: 'image/png' }, { type: 'text', text: '  Nachtrag\n🙂  ' }];
      const base = intent(value, { content: blocks }), original = hash(base);
      assertChatBodyContent(value, display); assertChatBodyContent(value, blocks);
      for (const content of ['different', '', [], [blocks[1], blocks[0]], [{ ...blocks[0], text: display + ' ' }, blocks[1]]])
        assert.throws(() => parseIntent({ ...base, content }));
      for (const content of [[{ ...blocks[0], textSignature: 'signature-b' }, ...blocks.slice(1)],
        [blocks[0], { ...blocks[1], data: '/api/files/uploads/other' }, blocks[2]],
        [blocks[0], { ...blocks[1], mimeType: 'image/jpeg' }, blocks[2]],
        [blocks[0], blocks[2], blocks[1]], [blocks[0], blocks[1], { ...blocks[2], text: 'changed' }]])
        assert.notEqual(hash({ ...base, content }), original);
      const renamed = structuredClone(value); renamed.bundles[0].caption = 'Neuer Name';
      assert.equal(hash(intent(renamed, { content: [{ ...blocks[0], text: projectChatBodyText(renamed) }, ...blocks.slice(1)] })), original);
    });

    check('current receipts enter only capture; body and stored public identity stay receipt free', () => {
      process.env.BETTER_AUTH_SECRET = 'synthetic-inline-body-syntax-secret-no-source-authority';
      const providerRef = createIntegrationProviderRef({ source: 'composio', profileId: 'profile-alice', toolkit: 'canva',
        scope: { type: 'user', ownerUserId: 'alice', resourceId: 'profile:profile-alice:canva' } });
      const issue = (revision: string) => createPersonalComposioAccountReference({ actorUserId: 'alice', workspaceId: 'workspace-alice', organizationId: null,
        providerRef, profileId: 'profile-alice', cacheRevision: 'cache-1', toolkit: 'canva', accountId: 'account-B', credentialRevision: revision });
      const firstReceipt = issue('credentials-1'), secondReceipt = issue('credentials-2'); assert.notEqual(firstReceipt, secondReceipt);
      const value = body(bundle(account, 'Canva'));
      const request = { userId: 'alice', sessionId: 'session-alice', clientMessageId: 'inline-1',
        message: { role: 'user', content: projectChatBodyText(value), timestamp: 1 }, body: value,
        selection: { version: 1, origin: 'turn_reference', selections: [{ ...account, accountSelectionRef: firstReceipt }] } };
      const captured = capture(request); assert.equal(captured.selection?.selections[0].accountSelectionRef, firstReceipt);
      assert(!JSON.stringify(captured.body).includes('cmp_personal_account_'));
      assert.equal(hash(intent(value, { selection: codec.receiptFreeChatExtensionSelection(captured.selection) })),
        hash(intent(value, { selection: codec.receiptFreeChatExtensionSelection({ ...request.selection, selections: [{ ...account, accountSelectionRef: secondReceipt }] }) })));
      assert.throws(() => capture({ ...request, selection: deriveChatBodySelection(value) }), 'An account body does not replace the current intake receipt');
      assert.throws(() => capture({ ...request, selection: null }));
      const wrongAccount = { ...account, selection: { ...account.selection, target: { ...account.selection.target, accountId: 'account-X', connectionRef: 'composio-personal:profile-alice:account-X' } } };
      assert.throws(() => capture({ ...request, selection: { ...request.selection, selections: [{ ...wrongAccount, accountSelectionRef: firstReceipt }] } }));
      request.body.bundles[0].caption = 'mutated'; assert.equal(captured.body?.bundles[0].caption, 'Canva');
    });

    check('actual stored V1 private codec roundtrip keeps body optional and consistent', () => {
      const value = body(), selected = deriveChatBodySelection(value)!;
      const stored = { version: 1, kind: 'accepted_chat_message',
        identity: { userId: 'alice', sessionId: 'session-alice', agentId: 'agent-a', workspaceId: 'workspace-alice', organizationId: null, projectId: null },
        serverMessageId: id(4), clientMessageId: 'inline-stored', mode: 'message', message: { role: 'user', content: projectChatBodyText(value), timestamp: 1 },
        context: {}, body: value, extensionSelection: { version: 1, kind: 'accepted_turn_extension_selection', publicSelection: selected,
          privateFixedBindings: [{ version: 1, kind: 'standalone', configurationId: 'turn-shared', mode: 'fixed', entry: { ...mcp,
            target: { kind: 'shared', source: 'mcp', connectionRef: mcp.selection.target.connectionRef, bindingRevision: 7 } } }] } };
      const parsed = parseStored(stored); assert.deepEqual(parsed, stored); assert(Object.isFrozen(parsed.body?.bundles[0]));
      assert.deepEqual(parseStored(JSON.parse(JSON.stringify(parsed))), parsed);
      assert.throws(() => parseStored({ ...stored, message: { ...stored.message, content: 'different' } }));
      assert.throws(() => parseStored({ ...stored, extensionSelection: null }));
      assert.throws(() => parseStored({ ...stored, body: null }));
      const { body: omitted, ...old } = stored; assert(omitted);
      assert.equal(Object.hasOwn(parseStored(old), 'body'), false);
    });

    check('plain JSON, accessor/toJSON, byte and depth limits fail before executing caller code', () => {
      let invoked = 0;
      const getter = body(); Object.defineProperty(getter, 'parts', { enumerable: true, get() { invoked++; return []; } }); rejects(getter);
      const nestedGetter = body(); Object.defineProperty(nestedGetter.bundles[0].primary, 'selection', { enumerable: true, get() { invoked++; return mcp.selection; } }); rejects(nestedGetter);
      rejects({ ...body(), toJSON() { invoked++; return body(); } });
      const cyclic = body() as ChatBodyV1 & { cycle?: unknown }; cyclic.cycle = cyclic; rejects(cyclic);
      rejects(Object.assign(Object.create({ inherited: true }), body()));
      rejects({ ...body(), [Symbol('private')]: true }); rejects({ ...body(), parts: new Array(1) });
      const nonEnumerable = body(); Object.defineProperty(nonEnumerable, 'hidden', { enumerable: false, value: 'hidden' }); rejects(nonEnumerable);
      const extraArray = body(); Object.assign(extraArray.parts, { hidden: 'hidden' }); rejects(extraArray);
      const deep: Record<string, unknown> = {}; let node = deep;
      for (let index = 0; index < 40; index++) { const next = {}; node.next = next; node = next; }
      rejects({ ...body(), unknown: deep }); assert.equal(invoked, 0);
      assert.equal(CHAT_BODY_MAX_BYTES, codec.DURABLE_CHAT_MESSAGE_MAX_BYTES);
      const empty: ChatBodyV1 = { version: 1, parts: [{ type: 'text', text: '' }], bundles: [] };
      const overhead = Buffer.byteLength(JSON.stringify(empty));
      empty.parts[0] = { type: 'text', text: 'a'.repeat(CHAT_BODY_MAX_BYTES - overhead) };
      assert.equal(Buffer.byteLength(JSON.stringify(empty)), CHAT_BODY_MAX_BYTES); parseChatBody(empty);
      rejects({ ...empty, parts: [{ type: 'text', text: `${(empty.parts[0] as { text: string }).text}a` }] });
      rejects({ version: 1, parts: [{ type: 'text', text: '🙂'.repeat(Math.floor(CHAT_BODY_MAX_BYTES / 4)) }], bundles: [] });
      rejects({ version: 1, parts: [{ type: 'text', text: '\n'.repeat(Math.floor(CHAT_BODY_MAX_BYTES / 2)) }], bundles: [] });
    });

    check('repeated large bundle canonicalization is linear; caption projection cannot amplify beyond 4MiB', () => {
      const large = bundle({ ...mcp, toolCap: Array.from({ length: 256 }, (_, index) => `READ_${index}_${'x'.repeat(220)}`) });
      const once = body(large); once.parts = [once.parts[1]];
      const repeated = structuredClone(once); repeated.parts = Array.from({ length: 64 }, (_, index) => ({ type: 'extension_reference', occurrenceId: `repeat-${index}`, bundleId: large.id }));
      parseChatBody(repeated);
      const onceBytes = Buffer.byteLength(JSON.stringify(canonicalChatBodyIntent(once)));
      const repeatedBytes = Buffer.byteLength(JSON.stringify(canonicalChatBodyIntent(repeated)));
      assert(repeatedBytes - onceBytes < 64 * 256, 'A bundle is not copied for each occurrence');
      assert(repeatedBytes < Buffer.byteLength(JSON.stringify(repeated)) * 2);
      assert.equal(deriveChatBodySelection(repeated)?.selections.length, 1);
      const caption = bundle(mcp, '🙂'.repeat(16_384));
      const explosion: ChatBodyV1 = { version: 1, bundles: [caption], parts: Array.from({ length: 65 }, (_, index) => ({ type: 'extension_reference', occurrenceId: `o-${index}`, bundleId: caption.id })) };
      assert(Buffer.byteLength(JSON.stringify(explosion)) < CHAT_BODY_MAX_BYTES);
      rejects(explosion); assert.throws(() => projectChatBodyText(explosion));
    });

    assert.equal(authorityCalls, 0);
    console.log(JSON.stringify({ status: 'PASS', cases, authorityCalls, browserBundle: 'PASS', sql: 'not-run', providerRequests: 0 }));
  } finally {
    loader._load = originalLoad;
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previousSecret;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
