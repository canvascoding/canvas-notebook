export type ToolDisplayTone =
  | 'command'
  | 'file'
  | 'search'
  | 'web'
  | 'image'
  | 'video'
  | 'sound'
  | 'data'
  | 'person'
  | 'style'
  | 'list'
  | 'automationList'
  | 'automationCreate'
  | 'automationUpdate'
  | 'automationDelete'
  | 'automationTrigger'
  | 'emailAccounts'
  | 'emailRead'
  | 'emailDraftCreate'
  | 'emailDraftUpdate'
  | 'emailSend'
  | 'mcp'
  | 'memory'
  | 'session'
  | 'delegation'
  | 'composioSearch'
  | 'composioSchema'
  | 'composioExecute'
  | 'composioConnections'
  | 'default';

export type ToolDisplayInfo = {
  label: string;
  tone: ToolDisplayTone;
};

type ToolDisplayEntry = {
  label: string;
  labelDe: string;
  tone: ToolDisplayTone;
};

const TOOL_DISPLAY: Record<string, ToolDisplayEntry> = {
  bash: { label: 'Ran a command', labelDe: 'Befehl ausgeführt', tone: 'command' },
  shell: { label: 'Ran a command', labelDe: 'Befehl ausgeführt', tone: 'command' },
  exec_command: { label: 'Ran a command', labelDe: 'Befehl ausgeführt', tone: 'command' },
  read: { label: 'Read a file', labelDe: 'Datei gelesen', tone: 'file' },
  cat: { label: 'Read a file', labelDe: 'Datei gelesen', tone: 'file' },
  write: { label: 'Updated a file', labelDe: 'Datei aktualisiert', tone: 'file' },
  edit: { label: 'Updated a file', labelDe: 'Datei aktualisiert', tone: 'file' },
  edit_file: { label: 'Updated a file safely', labelDe: 'Datei sicher aktualisiert', tone: 'file' },
  apply_patch: { label: 'Updated files', labelDe: 'Dateien aktualisiert', tone: 'file' },
  copy_path: { label: 'Copied files', labelDe: 'Dateien kopiert', tone: 'file' },
  move_path: { label: 'Moved files', labelDe: 'Dateien verschoben', tone: 'file' },
  delete_path: { label: 'Deleted files', labelDe: 'Dateien gelöscht', tone: 'file' },
  list_file_snapshots: { label: 'Listed file snapshots', labelDe: 'Datei-Snapshots geladen', tone: 'file' },
  restore_file_snapshot: { label: 'Restored a file', labelDe: 'Datei wiederhergestellt', tone: 'file' },
  rg: { label: 'Searched the workspace', labelDe: 'Workspace durchsucht', tone: 'search' },
  grep: { label: 'Searched the workspace', labelDe: 'Workspace durchsucht', tone: 'search' },
  glob: { label: 'Browsed files', labelDe: 'Dateien durchsucht', tone: 'file' },
  ls: { label: 'Browsed files', labelDe: 'Dateien durchsucht', tone: 'file' },
  web_fetch: { label: 'Opened a web page', labelDe: 'Webseite geöffnet', tone: 'web' },
  browser: { label: 'Used browser', labelDe: 'Browser verwendet', tone: 'web' },
  web_search: { label: 'Searched the web', labelDe: 'Web durchsucht', tone: 'web' },
  studio_generate_image: { label: 'Generated an image', labelDe: 'Bild generiert', tone: 'image' },
  studio_generate_video: { label: 'Generated a video', labelDe: 'Video generiert', tone: 'video' },
  studio_generate_sound: { label: 'Generated sound', labelDe: 'Sound generiert', tone: 'sound' },
  studio_bulk_generate: { label: 'Generated media', labelDe: 'Medien generiert', tone: 'image' },
  studio_list_products: { label: 'Loaded products', labelDe: 'Produkte geladen', tone: 'data' },
  studio_list_personas: { label: 'Loaded personas', labelDe: 'Personas geladen', tone: 'person' },
  studio_list_styles: { label: 'Loaded styles', labelDe: 'Stile geladen', tone: 'style' },
  studio_list_presets: { label: 'Loaded presets', labelDe: 'Presets geladen', tone: 'list' },
  list_automation_jobs: { label: 'Loaded automations', labelDe: 'Automationen geladen', tone: 'automationList' },
  create_automation_job: { label: 'Created automation', labelDe: 'Automation erstellt', tone: 'automationCreate' },
  update_automation_job: { label: 'Updated automation', labelDe: 'Automation aktualisiert', tone: 'automationUpdate' },
  delete_automation_job: { label: 'Deleted automation', labelDe: 'Automation gelöscht', tone: 'automationDelete' },
  trigger_automation_job: { label: 'Started automation', labelDe: 'Automation gestartet', tone: 'automationTrigger' },
  email_list_accounts: { label: 'Loaded email accounts', labelDe: 'E-Mail-Konten geladen', tone: 'emailAccounts' },
  email_search: { label: 'Searched email', labelDe: 'E-Mails durchsucht', tone: 'search' },
  email_read: { label: 'Read email', labelDe: 'E-Mail gelesen', tone: 'emailRead' },
  email_create_draft: { label: 'Created email draft', labelDe: 'E-Mail-Entwurf erstellt', tone: 'emailDraftCreate' },
  email_update_draft: { label: 'Updated email draft', labelDe: 'E-Mail-Entwurf aktualisiert', tone: 'emailDraftUpdate' },
  email_send_draft: { label: 'Sent email draft', labelDe: 'E-Mail-Entwurf gesendet', tone: 'emailSend' },
  mcp: { label: 'Used MCP', labelDe: 'MCP verwendet', tone: 'mcp' },
  memory: { label: 'Updated memory', labelDe: 'Memory aktualisiert', tone: 'memory' },
  session_search: { label: 'Searched sessions', labelDe: 'Sessions durchsucht', tone: 'session' },
  delegate_task: { label: 'Delegated task', labelDe: 'Aufgabe delegiert', tone: 'delegation' },
  COMPOSIO_SEARCH_TOOLS: { label: 'Searched external tools', labelDe: 'Externe Tools gesucht', tone: 'composioSearch' },
  COMPOSIO_GET_TOOL_SCHEMAS: { label: 'Loaded tool schemas', labelDe: 'Tool-Schemas geladen', tone: 'composioSchema' },
  composio_execute: { label: 'Ran external tool', labelDe: 'Externes Tool ausgeführt', tone: 'composioExecute' },
  COMPOSIO_MANAGE_CONNECTIONS: { label: 'Managed app connections', labelDe: 'App-Verbindungen verwaltet', tone: 'composioConnections' },
};

export function getToolDisplayInfo(toolName: string | undefined, locale: string): ToolDisplayInfo {
  const normalizedName = (toolName || '').trim();
  const display = normalizedName ? TOOL_DISPLAY[normalizedName] : undefined;
  if (display) {
    return {
      label: locale.startsWith('de') ? display.labelDe : display.label,
      tone: display.tone,
    };
  }

  if (normalizedName.startsWith('mcp_')) {
    return {
      label: locale.startsWith('de') ? 'MCP-Tool ausgeführt' : 'Ran MCP tool',
      tone: 'mcp',
    };
  }

  if (normalizedName.startsWith('COMPOSIO_')) {
    return {
      label: locale.startsWith('de') ? 'Composio-Tool verwendet' : 'Used Composio tool',
      tone: 'composioExecute',
    };
  }

  return {
    label: locale.startsWith('de') ? 'Aktion ausgeführt' : 'Completed an action',
    tone: 'default',
  };
}
