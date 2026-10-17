import assert from 'node:assert/strict';
import { z } from 'zod';
import Module from 'node:module';
import type { CanonicalMessageIntent } from '../app/lib/chat/durable-message-contracts';
import { CHAT_MESSAGE_ADMISSION_MAX_PRIVATE_PAYLOAD_BYTES } from '../app/lib/db/chat-message-admission-migration';
import type { ChatRequestContext } from '../app/lib/chat/types';
import type { ChatExtensionSelection } from '../app/lib/capabilities/extensions/contracts';
import { EXTENSION_SELECTION_LIMITS } from '../app/lib/capabilities/extensions/contracts';
import { createPersonalComposioAccountReference } from '../app/lib/composio/composio-shared-account-reference';
import { createIntegrationProviderRef } from '../app/lib/integration-tools/references';
import { toUploadMediaUrl } from '../app/lib/utils/media-url';

// Actual syntax/private-codec/crypto helpers only. This fixture creates no SQL
// session, source proof or execution permission and makes no provider requests.
async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  let preparationCalls = 0;
  // The existing accepted-turn module co-locates its genuine private parser with
  // runtime authority imports. Isolate only those unused imports, with hard
  // failures rather than successful source/authority substitutes.
  loader._load = (name, parent, isMain) => {
    if (parent?.filename.endsWith('/accepted-turn-selection.ts') && [
      './standalone-preparation', '@/app/lib/agents/actor-context', '@/app/lib/pi/session-workspace-context',
    ].includes(name)) {
      const forbidden = () => { preparationCalls++; throw new Error('The syntax codec must never prepare source authority.'); };
      return { prepareStandaloneExtensionSelection: forbidden, revalidatePreparedStandaloneExtensionSelection: forbidden,
        getPreparedStandaloneExtensionBinding: forbidden, withRevalidatedStandaloneTurnSelectionOnConnection: forbidden,
        resolveVerifiedAgentActorContextOnConnection: forbidden, readStoredAgentWorkspaceOnConnection: forbidden,
        workspaceToAgentExecutionContext: forbidden };
    }
    return originalLoad(name, parent, isMain);
  };
  try {
    const { canonicalMessageIntentHash, captureChatMessageAdmissionRequest, DURABLE_CHAT_MESSAGE_MAX_BYTES, parseCanonicalMessageIntent, parseStoredAcceptedChatMessage,
      receiptFreeChatExtensionSelection, storedAcceptedChatMessageSchema } = await import('../app/lib/chat/durable-message-contracts');
    const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
    const pin = { resourceRef: `canvas-resource:${id(1)}`, publishedRevisionRef: `canvas-package-revision:${id(2)}`, checksum: 'a'.repeat(64) };
    const plugin = { selection: { kind: 'plugin' as const, package: pin, skillSelection: { kind: 'all' as const } },
      requirement: 'optional' as const, toolCap: null };
    const shared = { selection: { kind: 'mcp' as const, source: 'mcp' as const,
      target: { kind: 'shared' as const, connectionRef: `canvas-connection:${id(3)}`, bindingRevision: 7 } },
      requirement: 'required' as const, toolCap: ['READ'] };
    const account = { selection: { kind: 'composio' as const, source: 'composio' as const, toolkit: 'canva',
      target: { kind: 'personal' as const, profileId: 'profile-alice', accountBinding: 'account' as const,
        accountId: 'account-B', connectionRef: 'composio-personal:profile-alice:account-B' } },
      requirement: 'optional' as const, toolCap: ['CREATE'] };
    const mapping = { package: pin, declarationPath: '.canvas-plugin/plugin.json', capabilityId: 'read',
      alternativeKey: 'mcp:source', connectionSelection: shared.selection };
    const chat = (selections: unknown[], packageConnections?: unknown[]) => ({ version: 1, origin: 'turn_reference', selections,
      ...(packageConnections === undefined ? {} : { packageConnections }) });
    const context: ChatRequestContext = { channelId: 'app', currentTime: '2026-10-14T12:00:00.000Z', userTimeZone: 'Europe/Berlin',
      activeFilePath: '  Arbeitsplan/Übung.md  ', planningMode: true, currentPage: '/workspace',
      workspace: { workspaceId: 'workspace-alice', workspaceType: 'personal', workspaceName: 'Arbeitsplatz', organizationId: null,
        canWrite: true, canDelete: false, canShare: false },
      todoContext: { todoId: 'todo-1', description: null, assignee: null, fileLinks: [{ workspacePath: 'notes/überblick.md', label: 'Überblick' }] },
      notebookContext: { activeSurface: { kind: 'document', path: 'Arbeitsplan/Übung.md' }, chatPlacement: 'full',
        openDocuments: [{ path: 'Arbeitsplan/Übung.md', state: 'active' }] },
      studioContext: { generationPrompt: '  unverändert\n🎨  ', generationProductIds: ['product-1'], outputMediaUrl: '/api/files/studio-image' },
      emailContext: { accountScope: 'personal', selectedMessageId: 'message-1', selectedMessageIsRead: null },
    };
    const upload = toUploadMediaUrl('upload-ä /1');
    const content = [{ type: 'text' as const, text: '  Original\nText 🎨 e\u0301  ', textSignature: 'opaque-original-signature' },
      { type: 'image' as const, data: upload, mimeType: 'image/png' }];
    const stored = () => ({ version: 1, kind: 'accepted_chat_message',
      identity: { userId: 'alice', sessionId: 'session-alice', agentId: 'agent-alice', workspaceId: 'workspace-alice',
        organizationId: null, projectId: null }, serverMessageId: id(4), clientMessageId: 'message_1:retry-1', mode: 'message',
      message: { role: 'user', content: structuredClone(content), timestamp: 123.5 }, context: structuredClone(context), extensionSelection: null });
    let assertions = 0;
    function accepts(value: unknown, description: string) {
      assertions++; assert(storedAcceptedChatMessageSchema.safeParse(value).success, description);
    }
    function rejects(value: unknown, description: string) {
      assertions++; assert.equal(storedAcceptedChatMessageSchema.safeParse(value).success, false, description);
      assert.throws(() => parseStoredAcceptedChatMessage(value), z.ZodError);
    }
    function changes(intent: CanonicalMessageIntent, patch: Partial<CanonicalMessageIntent>, description: string) {
      assertions++; assert.notEqual(canonicalMessageIntentHash({ ...intent, ...patch }), canonicalMessageIntentHash(intent), description);
    }

    const oldSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = 'synthetic-durable-message-contract-test-secret-no-execution-authority';
    try {
      assert.equal(DURABLE_CHAT_MESSAGE_MAX_BYTES, CHAT_MESSAGE_ADMISSION_MAX_PRIVATE_PAYLOAD_BYTES,
        'Actual private codec and PostgreSQL octet_length constraint use the same byte limit');
      const original = stored();
      const parsed = parseStoredAcceptedChatMessage(original);
      assert.deepEqual(parsed, original);
      assert.deepEqual(parsed.message.content, content, 'Do not trim, normalize Unicode, decode upload URLs or expand images');
      assert.equal((parsed.message.content[1] as { data: string }).data, upload);
      assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.context.notebookContext?.openDocuments)
        && Object.isFrozen(parsed.message.content[0]));
      original.context.workspace!.workspaceName = 'Changed later';
      assert.equal(parsed.context.workspace!.workspaceName, 'Arbeitsplatz', 'Parsed storage cannot alias a mutable caller object');
      accepts({ ...stored(), message: { role: 'user', content: '', timestamp: -0.25 } }, 'Preserve finite original timestamps and string content');
      accepts({ ...stored(), message: { role: 'user', content: [], timestamp: 0 } }, 'Codec does not invent semantic nonempty-message rules');

      const request = () => ({ userId: 'alice', sessionId: 'session-alice', clientMessageId: 'message_1:retry-1',
        expectedAgentId: 'agent-alice', expectedWorkspaceId: 'workspace-alice',
        message: { role: 'user' as const, content: structuredClone(content), timestamp: 123.5 }, context: structuredClone(context) });
      const callerRequest = request();
      const capturedRequest = captureChatMessageAdmissionRequest(callerRequest);
      assert.deepEqual(capturedRequest, { ...callerRequest, mode: 'message', selection: null });
      assert(Object.isFrozen(capturedRequest) && Object.isFrozen(capturedRequest.message.content)
        && Object.isFrozen(capturedRequest.context.workspace));
      const callerText = callerRequest.message.content[0];
      assert.equal(callerText.type, 'text');
      if (callerText.type === 'text') callerText.text = 'Changed after request capture';
      callerRequest.context.workspace!.workspaceId = 'changed-workspace';
      assert.deepEqual(capturedRequest.message.content, content, 'Full original request is cloned before an async caller can change it');
      assert.equal(capturedRequest.context.workspace!.workspaceId, 'workspace-alice');
      const minimalRequest = { userId: 'alice', sessionId: 'session-alice', clientMessageId: 'message-minimal',
        message: { role: 'user', content: '  exact\noriginal  ', timestamp: 0 } };
      assert.deepEqual(captureChatMessageAdmissionRequest(minimalRequest),
        { ...minimalRequest, context: {}, mode: 'message', selection: null });
      assert.deepEqual(captureChatMessageAdmissionRequest({ ...minimalRequest, context: null, selection: chat([], []) }),
        { ...minimalRequest, context: {}, mode: 'message', selection: null });
      const requestRejected = (value: unknown, description: string) => {
        assertions++; assert.throws(() => captureChatMessageAdmissionRequest(value), z.ZodError, description);
      };
      for (const patch of [{ message: { role: 'assistant', content: 'not user', timestamp: 1 } },
        { message: { ...minimalRequest.message, unknown: true } }, { message: { ...minimalRequest.message, timestamp: Infinity } },
        { message: { ...minimalRequest.message, timestamp: undefined } }, { context: undefined }, { mode: undefined }, { selection: undefined },
        { unknown: true }, { userId: '' }, { clientMessageId: 'bad\n' }, { turnExtensionSource: { kind: 'opaque' } }]) {
        requestRejected({ ...minimalRequest, ...patch }, 'Capture cannot project malformed fields into a valid request');
      }
      let requestGetterCalls = 0;
      const getter = () => { requestGetterCalls++; return minimalRequest.message; };
      const messageGetter = { ...minimalRequest };
      Object.defineProperty(messageGetter, 'message', { enumerable: true, get: getter });
      requestRejected(messageGetter, 'A getter on the original message is rejected before being read');
      const contentGetter = { ...minimalRequest, message: { ...minimalRequest.message } };
      Object.defineProperty(contentGetter.message, 'content', { enumerable: true, get: getter });
      requestRejected(contentGetter, 'A getter on content is rejected before being read');
      const identityGetter = { ...minimalRequest };
      Object.defineProperty(identityGetter, 'userId', { enumerable: true, get: getter });
      requestRejected(identityGetter, 'Identity is captured without a preliminary getter access');
      assert.equal(requestGetterCalls, 0);

      const publicSelection = receiptFreeChatExtensionSelection(chat([plugin, shared], [mapping]));
      assert(publicSelection);
      assert.deepEqual(publicSelection.packageConnections, [mapping]);
      assert(Object.isFrozen(publicSelection.packageConnections?.[0].package));
      const privateSelection = { version: 1, kind: 'accepted_turn_extension_selection', publicSelection,
        privateFixedBindings: [{ version: 1, kind: 'standalone', configurationId: 'turn-shared', mode: 'fixed',
          entry: { ...shared, target: { kind: 'shared', source: 'mcp', connectionRef: shared.selection.target.connectionRef, bindingRevision: 7 } } }] };
      accepts({ ...stored(), extensionSelection: privateSelection }, 'Reuse the genuine accepted-turn private codec including exact package mapping');
      rejects({ ...stored(), extensionSelection: { ...privateSelection, privateFixedBindings: [] } }, 'Private/source identity must match the public selection');
      assert.equal(parseStoredAcceptedChatMessage({ ...stored(), extensionSelection: { version: 1,
        kind: 'accepted_turn_extension_selection', publicSelection: chat([]), privateFixedBindings: [] } }).extensionSelection, null);
      for (const empty of [null, undefined, chat([]), chat([], [])]) assert.equal(receiptFreeChatExtensionSelection(empty), null);

      const providerRef = createIntegrationProviderRef({ source: 'composio', profileId: 'profile-alice', toolkit: 'canva',
        scope: { type: 'user', ownerUserId: 'alice', resourceId: 'profile:profile-alice:canva' } });
      const issue = (credentialRevision: string) => createPersonalComposioAccountReference({ actorUserId: 'alice',
        workspaceId: 'workspace-alice', organizationId: null, providerRef, profileId: 'profile-alice', cacheRevision: 'cache-1',
        toolkit: 'canva', accountId: 'account-B', credentialRevision });
      const receiptA = issue('credentials-1'), receiptB = issue('credentials-2');
      assert.notEqual(receiptA, receiptB);
      const accountSelection = receiptFreeChatExtensionSelection(chat([{ ...account, accountSelectionRef: receiptA }]));
      assert.deepEqual(accountSelection, receiptFreeChatExtensionSelection(chat([{ ...account, accountSelectionRef: receiptB }])));
      assert(!JSON.stringify(accountSelection).includes('cmp_personal_account_'));
      const requestWithAccount = captureChatMessageAdmissionRequest({ ...minimalRequest,
        selection: chat([{ ...account, accountSelectionRef: receiptA }]) });
      assert.equal(requestWithAccount.selection?.selections[0].accountSelectionRef, receiptA,
        'Capture keeps the genuine intake receipt for later source preparation; it is not durable identity');
      assert(Object.isFrozen(requestWithAccount.selection?.selections[0]));
      requestRejected({ ...minimalRequest, selection: chat([account]) }, 'Capture cannot omit an initial exact-account receipt');
      assert.throws(() => receiptFreeChatExtensionSelection(chat([account])), z.ZodError, 'Even a sole account needs an intake receipt');
      assert.throws(() => receiptFreeChatExtensionSelection(chat([{ ...account, retainedBindingRef: `agent-extension-retain:v1:${'a'.repeat(64)}` }])), z.ZodError);
      assert.throws(() => receiptFreeChatExtensionSelection(chat([{ ...plugin, accountSelectionRef: receiptA }])), z.ZodError);
      assert.throws(() => receiptFreeChatExtensionSelection({ ...chat([]), unknown: true }), z.ZodError);

      const intent: CanonicalMessageIntent = { content, context, mode: 'message', selection: accountSelection };
      const mutableIntent = structuredClone(intent);
      const capturedIntent = parseCanonicalMessageIntent(mutableIntent);
      assert.deepEqual(capturedIntent, intent);
      assert(Object.isFrozen(capturedIntent) && Object.isFrozen(capturedIntent.context?.workspace)
        && Object.isFrozen(capturedIntent.content) && Object.isFrozen(capturedIntent.selection?.selections));
      mutableIntent.context!.workspace!.workspaceId = 'changed-after-capture';
      assert.equal(capturedIntent.context!.workspace!.workspaceId, 'workspace-alice', 'Intent capture cannot race later caller mutations');
      assert.deepEqual(parseCanonicalMessageIntent({ ...intent, context: null, selection: chat([], []) }),
        { ...intent, context: {}, selection: null });
      assert.throws(() => parseCanonicalMessageIntent({ ...intent, context: accessorForIntent() }), z.ZodError);
      function accessorForIntent() {
        const value = {};
        Object.defineProperty(value, 'currentTime', { enumerable: true, get() { throw new Error('Intent getters must never execute'); } });
        return value;
      }
      const initialHash = canonicalMessageIntentHash(intent);
      assert.equal(initialHash, canonicalMessageIntentHash({ ...intent,
        selection: receiptFreeChatExtensionSelection(chat([{ ...account, accountSelectionRef: receiptB }])) }));
      assert.equal(initialHash, canonicalMessageIntentHash({ ...intent, context: { ...context, currentTime: 'later', userTimeZone: 'UTC',
        workspace: { ...context.workspace!, workspaceName: 'Renamed', workspaceDescription: 'Fresh description', brandContext: 'Fresh brand',
          workspaceType: 'organization', organizationId: 'fresh-metadata-org', canWrite: false, canDelete: true, canShare: true } } }));
      const reordered = Object.fromEntries(Object.entries(context).reverse());
      assert.equal(initialHash, canonicalMessageIntentHash({ ...intent, context: reordered }));
      assert.equal(canonicalMessageIntentHash({ ...intent, context: null, selection: null }),
        canonicalMessageIntentHash({ ...intent, context: {}, selection: chat([], []) as ChatExtensionSelection }));
      changes(intent, { content: 'Other text' }, 'Changed text is a distinct logical message');
      changes(intent, { content: [...content].reverse() }, 'Block order is exact user intent');
      changes(intent, { mode: 'steer' }, 'Steer cannot reuse the identity of an ordinary message');
      changes(intent, { context: { ...context, workspace: { ...context.workspace!, workspaceId: 'other-workspace' } } }, 'Workspace identity remains in the hash');
      changes(intent, { context: { ...context, planningMode: false } }, 'Planning mode remains user intent');
      changes(intent, { context: { ...context, activeFilePath: 'other.md' } }, 'File focus remains user intent');
      changes(intent, { selection: receiptFreeChatExtensionSelection(chat([{ ...account, selection: { ...account.selection,
        target: { ...account.selection.target, accountId: 'account-A', connectionRef: 'composio-personal:profile-alice:account-A' } }, accountSelectionRef: issue('credentials-3') }])) },
      'Canonical account identity changes the hash; receipt syntax never claims to authorize that account');
      changes({ ...intent, selection: publicSelection }, { selection: receiptFreeChatExtensionSelection(chat([
        { ...plugin, selection: { ...plugin.selection, package: { ...pin, publishedRevisionRef: `canvas-package-revision:${id(5)}` } } }, shared])) }, 'Held package pin changes the hash');
      changes({ ...intent, selection: publicSelection }, { selection: receiptFreeChatExtensionSelection(chat([plugin, { ...shared, toolCap: [] }], [mapping])) }, 'Empty tool cap differs from a callable selection');
      changes({ ...intent, selection: publicSelection }, { selection: receiptFreeChatExtensionSelection(chat([plugin, shared])) }, 'Exact package-to-connection focus is retained');

      for (const patch of [{ serverMessageId: 'not-a-uuid' }, { clientMessageId: '' }, { clientMessageId: 'a\n' },
        { clientMessageId: 'é' }, { clientMessageId: 'a'.repeat(129) }, { mode: 'follow_up' }, { unknown: true },
        { message: { role: 'assistant', content: 'untrusted', timestamp: 1 } },
        { message: { role: 'user', content: [{ type: 'thinking', thinking: 'private' }], timestamp: 1 } },
        { message: { role: 'user', content, timestamp: Infinity } }, { message: { role: 'user', content, timestamp: NaN } },
        { message: { role: 'user', content: [{ ...content[1], credentials: 'invalid' }], timestamp: 1 } },
        { context: { ...context, turnExtensionSource: { fingerprint: 'untrusted' } } },
        { context: { ...context, emailContext: { ...context.emailContext, password: 'invalid' } } },
        { context: { ...context, workspace: { ...context.workspace!, workspaceId: 'other-workspace' } } },
        { context: { ...context, workspace: { ...context.workspace!, organizationId: 'other-org' } } },
        { extensionSelection: chat([{ ...account, accountSelectionRef: receiptA }]) }]) rejects({ ...stored(), ...patch }, 'Malformed or additional stored fields fail closed');

      let getterCalls = 0;
      const accessor = stored();
      Object.defineProperty(accessor.context, 'currentTime', { enumerable: true, get() { getterCalls++; throw new Error('must not execute'); } });
      rejects(accessor, 'Accessors fail without being invoked');
      assert.equal(getterCalls, 0);
      const cyclic = stored();
      Object.assign(cyclic.context, { cycle: cyclic });
      rejects(cyclic, 'Cycles fail before schema traversal');
      rejects({ ...stored(), context: Object.assign(Object.create({ inherited: true }), context) }, 'Custom prototypes are rejected');
      rejects({ ...stored(), context: { ...context, [Symbol('hidden')]: true } }, 'Symbol properties cannot disappear during persistence');
      rejects({ ...stored(), context: { ...context, currentTime: undefined } }, 'Undefined is not silently dropped by the JSON codec');
      rejects({ ...stored(), message: { role: 'user', content: new Array(2), timestamp: 1 } }, 'Sparse arrays cannot silently become null');
      const customArray = [...content]; Object.setPrototypeOf(customArray, { toJSON() { getterCalls++; return []; } });
      rejects({ ...stored(), message: { role: 'user', content: customArray, timestamp: 1 } }, 'Array prototype serializers cannot transform payloads');
      assert.equal(getterCalls, 0);
      const hidden = stored(); Object.defineProperty(hidden.context, 'hidden', { value: true });
      rejects(hidden, 'Nonenumerable data cannot disappear');
      const large = { ...stored(), message: { role: 'user', content: '', timestamp: 1 } };
      const overhead = Buffer.byteLength(JSON.stringify(large));
      accepts({ ...large, message: { ...large.message, content: 'x'.repeat(DURABLE_CHAT_MESSAGE_MAX_BYTES - overhead) } }, 'Exact 4MiB JSON boundary is accepted');
      rejects({ ...large, message: { ...large.message, content: 'x'.repeat(DURABLE_CHAT_MESSAGE_MAX_BYTES - overhead + 1) } }, 'One UTF-8 byte above the boundary is rejected');
      rejects({ ...large, message: { ...large.message, content: 'é'.repeat(Math.floor(DURABLE_CHAT_MESSAGE_MAX_BYTES / 2)) } }, 'UTF-8 bytes, not UTF-16 length, bound Unicode payloads');
      rejects({ ...large, message: { ...large.message, content: '\n'.repeat(Math.floor(DURABLE_CHAT_MESSAGE_MAX_BYTES / 2)) } }, 'JSON escaping contributes to the persisted byte budget');
      const requestOverhead = Buffer.byteLength(JSON.stringify({ ...minimalRequest, message: { ...minimalRequest.message, content: '' } }));
      assert.equal(captureChatMessageAdmissionRequest({ ...minimalRequest,
        message: { ...minimalRequest.message, content: 'x'.repeat(DURABLE_CHAT_MESSAGE_MAX_BYTES - requestOverhead) } }).message.content.length,
      DURABLE_CHAT_MESSAGE_MAX_BYTES - requestOverhead, 'The full original request uses the actual 4MiB boundary');
      requestRejected({ ...minimalRequest,
        message: { ...minimalRequest.message, content: 'x'.repeat(DURABLE_CHAT_MESSAGE_MAX_BYTES - requestOverhead + 1) } },
      'Capture bounds the entire original request before defaults or projection can hide bytes');

      const tools = Array.from({ length: 256 }, (_, index) => `${index}`.padEnd(256, 'T'));
      const packageEntries = Array.from({ length: 4 }, (_, index) => ({ ...plugin,
        selection: { ...plugin.selection, package: { ...pin, resourceRef: `canvas-resource:${id(10 + index)}` },
          skillSelection: { kind: 'subset', relativeRoots: Array.from({ length: 128 }, (_, root) => `${root}`.padEnd(1024, 'r')) } }, toolCap: tools }));
      const largeShared = { ...shared, toolCap: tools };
      const extensionTooLarge = { ...privateSelection, publicSelection: chat([...packageEntries, largeShared],
        Array.from({ length: 128 }, (_, index) => ({ ...mapping, package: packageEntries[0].selection.package,
          declarationPath: `${index}`.padEnd(1024, 'd'), capabilityId: 'c'.repeat(256), alternativeKey: `mcp:${'m'.repeat(128)}` }))),
      privateFixedBindings: [{ ...privateSelection.privateFixedBindings[0], entry: { ...privateSelection.privateFixedBindings[0].entry, toolCap: tools } }] };
      assert(Buffer.byteLength(JSON.stringify(extensionTooLarge)) > EXTENSION_SELECTION_LIMITS.bytes);
      assert(Buffer.byteLength(JSON.stringify(extensionTooLarge)) < DURABLE_CHAT_MESSAGE_MAX_BYTES);
      rejects({ ...stored(), extensionSelection: extensionTooLarge }, 'The existing private extension limit remains 1MiB inside a larger message');
      requestRejected({ ...minimalRequest, selection: extensionTooLarge.publicSelection }, 'The public intake keeps its independent 1MiB limit');
      assert.throws(() => canonicalMessageIntentHash({ ...intent, context: accessor.context }), z.ZodError);
      assert.throws(() => receiptFreeChatExtensionSelection(Object.assign(Object.create({ origin: 'turn_reference' }), chat([]))));

      console.log(`PASS durable-message contracts: ${assertions} grouped assertions; actual private codec, receipt-free intent, stable uploads, strict JSON and 4MiB/1MiB boundaries. Syntax only; no SQL/source authority, runtime or provider execution tested.`);
    } finally {
      if (oldSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = oldSecret;
    }
    assert.equal(preparationCalls, 0, 'No source preparation or authority service was invoked');
  } finally {
    loader._load = originalLoad;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
