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
  | 'automation'
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
  apply_patch: { label: 'Updated files', labelDe: 'Dateien aktualisiert', tone: 'file' },
  rg: { label: 'Searched the workspace', labelDe: 'Workspace durchsucht', tone: 'search' },
  grep: { label: 'Searched the workspace', labelDe: 'Workspace durchsucht', tone: 'search' },
  glob: { label: 'Browsed files', labelDe: 'Dateien durchsucht', tone: 'file' },
  ls: { label: 'Browsed files', labelDe: 'Dateien durchsucht', tone: 'file' },
  web_fetch: { label: 'Opened a web page', labelDe: 'Webseite geöffnet', tone: 'web' },
  web_search: { label: 'Searched the web', labelDe: 'Web durchsucht', tone: 'web' },
  studio_generate_image: { label: 'Generated an image', labelDe: 'Bild generiert', tone: 'image' },
  studio_generate_video: { label: 'Generated a video', labelDe: 'Video generiert', tone: 'video' },
  studio_generate_sound: { label: 'Generated sound', labelDe: 'Sound generiert', tone: 'sound' },
  studio_bulk_generate: { label: 'Generated media', labelDe: 'Medien generiert', tone: 'image' },
  studio_list_products: { label: 'Loaded products', labelDe: 'Produkte geladen', tone: 'data' },
  studio_list_personas: { label: 'Loaded personas', labelDe: 'Personas geladen', tone: 'person' },
  studio_list_styles: { label: 'Loaded styles', labelDe: 'Stile geladen', tone: 'style' },
  studio_list_presets: { label: 'Loaded presets', labelDe: 'Presets geladen', tone: 'list' },
  list_automation_jobs: { label: 'Loaded automations', labelDe: 'Automationen geladen', tone: 'automation' },
  create_automation_job: { label: 'Created automation', labelDe: 'Automation erstellt', tone: 'automation' },
  update_automation_job: { label: 'Updated automation', labelDe: 'Automation aktualisiert', tone: 'automation' },
  delete_automation_job: { label: 'Deleted automation', labelDe: 'Automation gelöscht', tone: 'automation' },
  trigger_automation_job: { label: 'Started automation', labelDe: 'Automation gestartet', tone: 'automation' },
  email_list_accounts: { label: 'Loaded email accounts', labelDe: 'E-Mail-Konten geladen', tone: 'data' },
  email_search: { label: 'Searched email', labelDe: 'E-Mails durchsucht', tone: 'search' },
  email_read: { label: 'Read email', labelDe: 'E-Mail gelesen', tone: 'data' },
  email_create_draft: { label: 'Created email draft', labelDe: 'E-Mail-Entwurf erstellt', tone: 'data' },
  email_update_draft: { label: 'Updated email draft', labelDe: 'E-Mail-Entwurf aktualisiert', tone: 'data' },
  email_send_draft: { label: 'Sent email draft', labelDe: 'E-Mail-Entwurf gesendet', tone: 'data' },
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

  return {
    label: locale.startsWith('de') ? 'Aktion ausgeführt' : 'Completed an action',
    tone: 'default',
  };
}
