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
