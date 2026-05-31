import 'server-only';

import { readManagedAgentFile } from '@/app/lib/agents/storage';

import type { AutomationJobRecord } from './types';

export async function buildHeartbeatPrompt(job: AutomationJobRecord): Promise<string> {
  const heartbeatContent = await readManagedAgentFile('HEARTBEAT.md', job.agentId);
  const heartbeatPath = `/data/agents/${job.agentId || 'canvas-agent'}/HEARTBEAT.md`;

  return [
    `Lies die Datei ${heartbeatPath} und führe die darin beschriebenen Instructions aus.`,
    'Die Ergebnisse sollen in dieser Automation-Session kommuniziert und danach über das konfigurierte Delivery-Ziel ausgeliefert werden.',
    '',
    'Inhalt der HEARTBEAT.md:',
    '---',
    heartbeatContent.trim() || '(HEARTBEAT.md ist leer.)',
    '---',
  ].join('\n');
}
