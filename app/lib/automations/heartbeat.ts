import 'server-only';

import { readManagedAgentFile } from '@/app/lib/agents/storage';

import type { AutomationIntervalUnit, AutomationJobRecord, AutomationWeekday, FriendlySchedule } from './types';

type BuildHeartbeatPromptOptions = {
  includeAutomatedRuntimeContext?: boolean;
};

const WEEKDAY_LABELS: Record<AutomationWeekday, string> = {
  mon: 'Montag',
  tue: 'Dienstag',
  wed: 'Mittwoch',
  thu: 'Donnerstag',
  fri: 'Freitag',
  sat: 'Samstag',
  sun: 'Sonntag',
};

function formatIntervalUnit(every: number, unit: AutomationIntervalUnit): string {
  if (unit === 'minutes') return every === 1 ? 'Minute' : 'Minuten';
  if (unit === 'hours') return every === 1 ? 'Stunde' : 'Stunden';
  return every === 1 ? 'Tag' : 'Tage';
}

function formatSchedule(schedule: FriendlySchedule): string {
  if (schedule.kind === 'interval') {
    return `Intervall: alle ${schedule.every} ${formatIntervalUnit(schedule.every, schedule.unit)} (Zeitzone: ${schedule.timeZone}).`;
  }

  if (schedule.kind === 'daily') {
    return `Täglich um ${schedule.times.join(', ')} (Zeitzone: ${schedule.timeZone}).`;
  }

  if (schedule.kind === 'weekly') {
    const days = schedule.days.map((day) => WEEKDAY_LABELS[day] || day).join(', ');
    return `Wöchentlich an ${days} um ${schedule.times.join(', ')} (Zeitzone: ${schedule.timeZone}).`;
  }

  if (schedule.kind === 'once') {
    return `Einmalig am ${schedule.date} um ${schedule.time} (Zeitzone: ${schedule.timeZone}).`;
  }

  return `Webhook-getriggert (Zeitzone: ${schedule.timeZone}).`;
}

function formatWorkingHours(schedule: FriendlySchedule): string {
  const workingHours = schedule.workingHours;
  if (!workingHours || !workingHours.enabled) {
    return 'Arbeitszeitfenster: nicht aktiv.';
  }

  const days = workingHours.days.map((day) => WEEKDAY_LABELS[day] || day).join(', ');
  return `Arbeitszeitfenster: ${days}, ${workingHours.start}-${workingHours.end} (Zeitzone: ${workingHours.timeZone}).`;
}

function buildAutomatedHeartbeatContext(job: AutomationJobRecord): string[] {
  return [
    'AUTOMATISCHER HEARTBEAT-KONTEXT',
    'Dies ist ein automatisch geplanter Heartbeat-Lauf für diesen Agenten, keine vom User gerade gestartete normale Automation.',
    'Lege keinen neuen Automation-Job an und ändere den Heartbeat-Zeitplan nicht selbst, außer der User fordert das ausdrücklich an.',
    `Aktueller Heartbeat-Zeitplan: ${formatSchedule(job.schedule)}`,
    formatWorkingHours(job.schedule),
    `Aktueller Agent: ${job.agentId}.`,
    'Wenn der User das Heartbeat-Intervall, den Zeitplan, das Arbeitszeitfenster, das Delivery-Ziel oder die HEARTBEAT.md ändern will, sage ihm: Öffne /settings?tab=agent-settings, wähle diesen Agenten und bearbeite dort den Abschnitt "Heartbeat".',
    'Erwähne diesen Einstellungsort nur, wenn es im Gespräch um Heartbeat-Konfiguration oder Änderungen daran geht.',
  ];
}

export async function buildHeartbeatPrompt(job: AutomationJobRecord, options: BuildHeartbeatPromptOptions = {}): Promise<string> {
  const heartbeatContent = await readManagedAgentFile('HEARTBEAT.md', job.agentId);
  const heartbeatPath = `/data/agents/${job.agentId || 'canvas-agent'}/HEARTBEAT.md`;
  const context = options.includeAutomatedRuntimeContext ? [...buildAutomatedHeartbeatContext(job), ''] : [];

  return [
    ...context,
    `Lies die Datei ${heartbeatPath} und führe die darin beschriebenen Instructions aus.`,
    'Die Ergebnisse sollen in dieser Automation-Session kommuniziert und danach über das konfigurierte Delivery-Ziel ausgeliefert werden.',
    '',
    'Inhalt der HEARTBEAT.md:',
    '---',
    heartbeatContent.trim() || '(HEARTBEAT.md ist leer.)',
    '---',
  ].join('\n');
}
