import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function main() {
  const [
    profileSwitcher,
    connectedApps,
    toolkitDialog,
    automations,
    chatMapping,
    chatList,
    germanMessages,
    englishMessages,
  ] = await Promise.all([
    readFile('app/components/settings/ComposioProfileSwitcher.tsx', 'utf8'),
    readFile('app/components/settings/ConnectedAppsPanel.tsx', 'utf8'),
    readFile('app/components/settings/ToolkitToolsDialog.tsx', 'utf8'),
    readFile('app/apps/automations/components/AutomationsClient.tsx', 'utf8'),
    readFile('app/components/canvas-agent-chat/chatMessageMapping.ts', 'utf8'),
    readFile('app/components/canvas-agent-chat/ChatMessageList.tsx', 'utf8'),
    readFile('messages/de.json', 'utf8'),
    readFile('messages/en.json', 'utf8'),
  ]);

  assert.match(profileSwitcher, /data-testid="composio-profile-context"/u);
  assert.match(profileSwitcher, /\/api\/composio\/workspace-profile/u);
  assert.match(profileSwitcher, /workspace_override/u);
  assert.match(profileSwitcher, /workspaceOverrideCount/u);
  assert.match(profileSwitcher, /onEffectiveProfileUsageChange/u);
  assert.match(profileSwitcher, /\/api\/composio\/profiles/u);
  assert.match(profileSwitcher, /WORKSPACE_ID_HEADER/u);

  assert.match(connectedApps, /ComposioProfileSwitcher/u);
  assert.match(connectedApps, /secretScope=system/u);
  assert.match(connectedApps, /isAdmin/u);
  assert.match(connectedApps, /WORKSPACE_ID_HEADER/u);
  assert.match(connectedApps, /data-testid="composio-connect-context-dialog"/u);
  assert.match(connectedApps, /connectContext\.createProfile/u);
  assert.match(connectedApps, /profileCreateRequest/u);
  assert.match(toolkitDialog, /workspaceId/u);
  assert.match(toolkitDialog, /WORKSPACE_ID_HEADER/u);

  assert.match(automations, /effectiveProfile/u);
  assert.match(automations, /composioConnectionManagedByViewer/u);
  assert.match(automations, /connectionManagedByResponsibleUser/u);
  assert.match(automations, /composioWorkspaceHeaders/u);

  assert.match(chatMapping, /payload\.profile_name/u);
  assert.match(chatMapping, /auth_required === true/u);
  assert.match(chatList, /meta\.profileName/u);
  assert.match(chatList, /meta\.workspaceId/u);

  const de = JSON.parse(germanMessages) as Record<string, unknown>;
  const en = JSON.parse(englishMessages) as Record<string, unknown>;
  assert.ok(de.settings && de.chat);
  assert.ok(en.settings && en.chat);

  console.log('composio-profile-ui-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
