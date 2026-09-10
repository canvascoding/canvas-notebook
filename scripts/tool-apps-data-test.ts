import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'parse5';
import { presentAutomationAppData, readAutomationAppData } from '../app/lib/tool-apps/automation-data';
import type { AutomationJobRecord } from '../app/lib/automations/types';

async function main() {
  const job = { id: 'job-11111111-1111-4111-8111-111111111111', name: '<script>alert(1)</script>', status: 'active', revision: 2,
    schedule: { kind: 'daily', times: ['09:00'], timeZone: 'Europe/Berlin', privateValue: 'never-forward-this' },
    nextRunAt: '2026-09-11T07:00:00.000Z', updatedAt: '2026-09-10T07:00:00.000Z',
    triggerKind: 'schedule', integrityStatus: 'valid', prompt: 'never-forward-this', composioConnectedAccountId: 'never-forward-this',
  } as unknown as AutomationJobRecord;
  const data = presentAutomationAppData(job);
  assert.equal(data.name, job.name); // The React view must escape content, not destroy user data.
  assert.ok(!JSON.stringify(data).includes('never-forward-this'));
  assert.deepEqual(readAutomationAppData(data), data);
  assert.equal(readAutomationAppData({ ...data, revision: -1 }), null);
  assert.equal(readAutomationAppData({ ...data, schedule: { kind: 'daily', times: ['99:99'] } }), null);
  assert.equal(readAutomationAppData({ ...data, nextRunAt: 'tomorrow' }), null);
  assert.equal(readAutomationAppData({ ...data, name: 'x'.repeat(121) }), null);
  const html = await readFile('public/_canvas-tool-apps/automation-job-v1.html', 'utf8');
  assert.ok(Buffer.byteLength(html) < 2 * 1024 * 1024);
  assert.match(html, /data:font\/ttf;base64,/);
  assert.match(html, /CanvasWidgetSans/);
  type Node = { nodeName: string; childNodes?: Node[] };
  const scriptCount = (node: Node): number => Number(node.nodeName === 'script') + (node.childNodes || []).reduce((sum, child) => sum + scriptCount(child), 0);
  assert.equal(scriptCount(parse(html)), 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  console.log('tool-apps-data-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
