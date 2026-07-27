import 'server-only';

import { readManagedAgentFile } from '@/app/lib/agents/storage';

import { HEARTBEAT_OK_TOKEN } from './heartbeat-result';
import type { AutomationIntervalUnit, AutomationJobRecord, AutomationWeekday, FriendlySchedule } from './types';

type BuildHeartbeatPromptOptions = {
  includeAutomatedRuntimeContext?: boolean;
  userId?: string | null;
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

  if (schedule.kind === 'monthly') {
    return `Monatlich am ${schedule.dayOfMonth}. um ${schedule.time} (Zeitzone: ${schedule.timeZone}).`;
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
  const heartbeatContent = await readManagedAgentFile('HEARTBEAT.md', job.agentId, { userId: options.userId });
  const context = options.includeAutomatedRuntimeContext ? [...buildAutomatedHeartbeatContext(job), ''] : [];

  return [
    ...context,
    'Führe die unten eingebetteten Heartbeat-Anweisungen aus.',
    '',
    'Inhalt der HEARTBEAT.md:',
    '---',
    heartbeatContent.trim() || '(HEARTBEAT.md ist leer.)',
    '---',
    '',
    'VERBINDLICHES HEARTBEAT-ANTWORTPROTOKOLL',
    'Die HEARTBEAT.md bestimmt die auszuführenden Prüfungen und Aktionen. Dieses Protokoll bestimmt, ob das Ergebnis an den User ausgeliefert wird.',
    'Führe zuerst alle vorgesehenen Prüfungen und Aktionen vollständig aus.',
    `Wenn danach keine neue, konkrete oder anderweitig relevante Information für den User besteht, antworte ausschließlich mit exakt ${HEARTBEAT_OK_TOKEN}.`,
    'Eine reine Routinebestätigung, eine Wiederholung eines unveränderten Stands oder eine allgemeine Check-in-Frage ist keine relevante Information.',
    'Bei Fehlern, Blockern, notwendigen Rückfragen oder Informationen, die Aufmerksamkeit erfordern, antworte stattdessen mit einer kurzen normalen Nachricht.',
    `Setze ${HEARTBEAT_OK_TOKEN} nie in einen Markdown-Codeblock und ergänze davor oder danach keinen weiteren Text, keine Satzzeichen und keine Formatierung.`,
    `Eine alleinige Antwort mit ${HEARTBEAT_OK_TOKEN} wird intern als erfolgreicher Heartbeat ohne neue Hinweise erfasst und nicht an den User ausgeliefert.`,
  ].join('\n');
}
