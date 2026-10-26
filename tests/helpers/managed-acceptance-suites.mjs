// These suites have separate supervisors/private fixtures. Their own configs
// keep their admission guards; the ordinary suite must not invoke them unowned.
export const managedAcceptanceTestIgnore = [
  '**/*-local.spec.ts',
  '**/agent-extension-choice.e2e.spec.ts',
  '**/agent-extension-editor.e2e.spec.ts',
  '**/chat-extension-native.e2e.spec.ts',
  '**/chat-extension-natural-model.e2e.spec.ts',
  '**/chat-inline-references.e2e.spec.ts',
  '**/chat-queue-recovery.e2e.spec.ts',
  '**/plugin-extension-search.e2e.spec.ts',
  '**/composio-live.spec.ts',
  '**/composio-live-model.spec.ts',
  '**/direct-mcp-native-create-import.spec.ts',
];

const ownedYjsOnly = [
  '**/document-read-http.spec.ts',
  '**/native-markdown-sandbox.spec.ts',
  '**/native-metadata-writer.spec.ts',
];
const ownedBatchOnly = [
  '**/workspace-operation-batches.spec.ts',
  '**/workspace-path-operation-notifications.spec.ts',
];

/** These flags select discovery only. The original tests still verify their
 * supervisor, physical DATA, database and receipts before doing acceptance work. */
export function managedAcceptanceSelection(environment = process.env) {
  const yjs = environment.CANVAS_YJS_AUTHORITY_E2E === '1';
  const batch = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(environment.CANVAS_BATCH_E2E_RUN_ID ?? '');
  const excludedTags = [
    ...(!yjs ? ['@owned-yjs'] : []),
    ...(environment.CANVAS_PI_CHAT_LIVE_E2E !== '1' ? ['@live-model'] : []),
    ...(environment.CANVAS_DOCUMENT_REVIEW_E2E !== '1' ? ['@experimental-review'] : []),
  ];
  return {
    testIgnore: [
      ...managedAcceptanceTestIgnore,
      ...(!yjs ? ownedYjsOnly : []),
      ...(!batch ? ownedBatchOnly : []),
      ...(!batch && !yjs ? ['**/workspace-operation-automatic.spec.ts'] : []),
      ...(environment.CANVAS_COLLABORATION_QA !== '1' ? ['**/file-version-center-global.spec.ts'] : []),
    ],
    grepInvert: excludedTags.length ? new RegExp(excludedTags.join('|'), 'u') : undefined,
  };
}

/** A live provider is never contacted through ordinary discovery or a remote
 * production origin. Actual authentication/provider readiness stay in the test. */
export function requireLivePiChatTarget(environment = process.env) {
  const message = 'Live PI model acceptance requires its explicit production-mode loopback runner.';
  if (environment.CANVAS_PI_CHAT_LIVE_E2E !== '1' || environment.E2E_EXTERNAL_SERVER !== '1'
    || environment.NODE_ENV !== 'production') throw new Error(message);
  let target;
  try { target = new URL(environment.BASE_URL ?? ''); } catch { throw new Error(message); }
  if (!['http:', 'https:'].includes(target.protocol) || !['127.0.0.1', 'localhost'].includes(target.hostname)
    || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error(message);
  return target.origin;
}
