import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/de.json';
import type { AutomationJobRecord, AutomationRunRecord } from '../app/lib/automations/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/de/automations',
});
for (const key of [
  'window',
  'document',
  'navigator',
  'Element',
  'Document',
  'HTMLDetailsElement',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLAnchorElement',
  'HTMLTextAreaElement',
  'SVGElement',
  'Node',
  'NodeFilter',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

const workspace = {
  id: 'ws-1',
  type: 'personal',
  name: 'My workspace',
  status: 'active',
  permissions: { canRead: true, canWrite: true, canRunAgent: true },
};
const workspaceState = { workspaces: [workspace], initialized: true, hydrateWorkspaces: async () => {} };
const navigation: string[] = [];
const errors: string[] = [];
const internals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => {
  if (request === '@/app/components/editor/MarkdownEditorClient')
    return {
      MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
        <textarea aria-label="Task prompt" value={value} onChange={(event) => onChange(event.target.value)} />
      ),
    };
  if (request === '@/app/components/shared/MarkdownRenderer')
    return { MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> };
  if (request === '@/app/store/workspace-store')
    return {
      useWorkspaceStore: (selector: (state: unknown) => unknown) => selector(workspaceState),
      selectActiveWorkspace: () => workspace,
    };
  if (request === '@/i18n/navigation')
    return {
      Link: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
      useRouter: () => ({ push: (href: string) => navigation.push(href) }),
    };
  if (request === 'sonner')
    return {
      toast: {
        success() {},
        error(message: string) {
          errors.push(message);
        },
      },
    };
  return originalLoad(request, parent, isMain);
};

const job = {
  id: 'job-1',
  name: 'Daily project',
  prompt: 'PROMPT_SENTINEL',
  status: 'active',
  workspaceId: 'ws-1',
  workspaceType: 'personal',
  scope: 'personal',
  agentId: 'bradley',
  preferredSkill: 'auto',
  deliveryMode: 'web',
  deliveryChannelId: 'web',
  deliverySessionMode: 'new_session',
  deliverySessionId: null,
  deliveryChannelSessionKey: '',
  resultPolicy: 'deliver_all',
  triggerKind: 'schedule',
  jobType: 'default',
  nextRunAt: '2026-09-06T09:00:00Z',
  lastRunStatus: 'success',
  timeZone: 'UTC',
  schedule: {
    kind: 'daily',
    times: ['09:00', '15:00'],
    timeZone: 'UTC',
    workingHours: { enabled: true, days: ['mon'], start: '08:00', end: '18:00', timeZone: 'UTC' },
  },
} as AutomationJobRecord;
const run: AutomationRunRecord = {
  id: 'run-1',
  jobId: job.id,
  status: 'success',
  resultText: 'RUN_RESULT_SENTINEL',
  finishedAt: '2026-09-05T09:02:00Z',
  scheduledFor: '2026-09-05T09:00:00Z',
  attemptNumber: 1,
  triggerType: 'scheduled',
  metadataJson: { provider: 'TECHNICAL_SENTINEL' },
  piSessionId: 'chat-1',
  hasPersistedSession: true,
  scope: 'personal',
  jobScope: 'personal',
  organizationId: null,
  workspaceId: 'ws-1',
  workspaceType: 'personal',
  actorType: 'user',
  actorUserId: 'user-1',
  serviceActorId: null,
  startedAt: '2026-09-05T09:00:00Z',
  outputDir: null,
  targetOutputPath: null,
  effectiveTargetOutputPath: null,
  logPath: null,
  resultPath: null,
  errorMessage: null,
  piSessionTitle: 'Project meeting',
  createdAt: '2026-09-05T09:00:00Z',
  eventsLog: null,
};
const requests: Array<{ url: URL; method: string; body?: Record<string, unknown> }> = [];
const agents = [
  { agentId: 'bradley', name: 'Bradley', type: 'main', removable: false },
  { agentId: 'research', name: 'Research', type: 'custom', removable: true },
];
let chatFail = false;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input), 'http://localhost');
  requests.push({
    url,
    method: init?.method || 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  });
  let payload: unknown = { success: true, data: [] };
  if (url.pathname === '/api/automations/jobs') payload = { success: true, data: [job] };
  else if (url.pathname === '/api/automations/jobs/job-1' && init?.method === 'PATCH')
    payload = { success: true, data: { ...job, ...JSON.parse(String(init.body)) } };
  else if (url.pathname === '/api/automations/jobs/job-1/runs') payload = { success: true, data: [run] };
  else if (url.pathname === '/api/automations/runs/run-1') payload = { success: true, data: run };
  else if (url.pathname.endsWith('/logs'))
    payload = { success: true, data: { content: 'LOG_SENTINEL', truncated: false } };
  else if (url.pathname === '/api/agents') payload = { success: true, data: { agents } };
  else if (url.pathname === '/api/automations/chats') {
    if (chatFail) return new Response(JSON.stringify({ success: false }), { status: 503 });
    const query = url.searchParams.get('query');
    payload = {
      success: true,
      data: {
        chats:
          query && !'project meeting'.includes(query.toLowerCase())
            ? []
            : [{ sessionId: 'chat-1', title: 'Project meeting', lastActivityAt: '2026-09-05T09:00:00Z' }],
        nextCursor: null,
      },
    };
  } else if (url.pathname === '/api/sessions/messages')
    payload = { success: true, messages: [{ id: 1, role: 'assistant', content: 'CHAT_SENTINEL' }] };
  return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
};

async function main() {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { fireEvent } = await import('@testing-library/react');
  const { AutomationsClient } = await import('../app/apps/automations/components/AutomationsClient');
  const { AutomationChatPicker } = await import('../app/apps/automations/components/AutomationChatPicker');
  const settle = async (ms = 20) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };
  const click = async (element: Element | null | undefined) => {
    assert.ok(
      element,
      `Expected control to exist. Visible buttons: ${[...document.querySelectorAll('button')].map((button) => button.textContent).join(' | ')}`,
    );
    await act(async () => {
      fireEvent.click(element);
    });
    await settle();
  };
  const button = (label: string) =>
    [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === label);
  const openSection = async (label: string) => {
    const summary = [...document.querySelectorAll('summary')].find((element) =>
      element.textContent?.startsWith(label),
    );
    assert.ok(summary, `Missing section ${label}`);
    await act(async () => {
      const details = summary.parentElement as HTMLDetailsElement;
      details.open = true;
      fireEvent(details, new dom.window.Event('toggle'));
    });
    await settle();
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root = createRoot(container);
  const mount = async (children: React.ReactNode) => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="de" timeZone="UTC" messages={messages}>
          {children}
        </NextIntlClientProvider>,
      );
    });
    await settle();
  };
  await mount(<AutomationsClient initialTimeZone="UTC" />);
  assert.equal(document.querySelectorAll('[data-testid="automation-job-job-1"]').length, 1);
  assert.equal(
    document.querySelector('[data-testid="automation-job-job-1"]')?.getAttribute('href'),
    '/automations/job-1',
  );
  assert.ok(!document.body.textContent?.includes('PROMPT_SENTINEL'));
  await click(document.querySelector('[data-testid="automation-new"]'));
  assert.ok(document.querySelector('[data-testid="automation-scheduled-task-fields"]'));
  const fields = document.querySelector('[data-testid="automation-scheduled-task-fields"]')!;
  const order = [...fields.querySelectorAll('[data-testid]')].map((element) =>
    element.getAttribute('data-testid'),
  );
  assert.ok(order.indexOf('automation-agent-picker') < order.indexOf('automation-prompt'));
  assert.equal(
    document.querySelector('[data-testid="automation-schedule-kind"]'),
    null,
    'Schedule settings start collapsed',
  );
  assert.ok(!document.body.textContent?.includes('relevante Dateien oder Ordner auswählen'));
  assert.equal(document.querySelector('[data-testid="automation-context-paths"]'), null);
  assert.equal(document.querySelector('[data-testid="automation-target-output-picker"]'), null);
  await click(document.querySelector('[data-testid="automation-agent-picker"]'));
  const agentSearch = document.querySelector('[data-automation-picker] input');
  assert.ok(agentSearch);
  await act(async () => {
    fireEvent.keyDown(agentSearch, { key: 'Escape' });
  });
  await settle();
  assert.equal(document.querySelector('[data-automation-picker]'), null);
  assert.ok(
    document.querySelector('[data-testid="automation-scheduled-task-fields"]'),
    'Escape preserves the editor',
  );
  await click(document.querySelector('[data-testid="automation-agent-picker"]'));
  await click(button('Research'));
  assert.match(
    document.querySelector('[data-testid="automation-agent-picker"]')?.textContent || '',
    /Research/,
  );
  await openSection('Chat & Benachrichtigungen');
  assert.equal(document.querySelector('[data-testid="automation-chat-picker"]'), null);
  await click(button('Chat auswählen'));
  await click(document.querySelector('[data-testid="automation-chat-picker"]'));
  await settle();
  const selection = [...document.querySelectorAll('button')].find((element) =>
    element.textContent?.includes('Project meeting'),
  );
  await click(selection);
  assert.match(
    document.querySelector('[data-testid="automation-chat-picker"]')?.textContent || '',
    /Project meeting/,
  );
  assert.ok(
    requests.some(
      ({ url }) =>
        url.pathname === '/api/automations/chats' &&
        url.searchParams.get('agentId') === 'research' &&
        url.searchParams.get('workspaceId') === 'ws-1',
    ),
  );
  await click(document.querySelector('[data-testid="automation-agent-picker"]'));
  await click(button('Bradley'));
  assert.equal(
    document.querySelector('[data-testid="automation-chat-picker"]'),
    null,
    'Agent changes clear a fixed chat',
  );
  await act(async () => root.unmount());
  root = createRoot(container);
  requests.length = 0;
  await mount(<AutomationsClient initialJobId="job-1" initialTimeZone="UTC" />);
  assert.ok(document.querySelector('[data-testid="automation-detail-summary"]'));
  assert.equal(
    document.querySelector('[data-testid="automation-name"]'),
    null,
    'Details do not immediately open an editor',
  );
  assert.ok(document.body.textContent?.includes('RUN_RESULT_SENTINEL'));
  assert.ok(!document.body.textContent?.includes('TECHNICAL_SENTINEL'));
  await click(document.querySelector('[data-testid="automation-edit"]'));
  await click(document.querySelector('[data-testid="automation-save"]'));
  const saved = requests.find(({ method }) => method === 'PATCH')?.body;
  assert.ok(saved);
  assert.equal('workspaceContextPaths' in saved, false);
  assert.equal('targetOutputPath' in saved, false);
  assert.deepEqual(
    saved.schedule,
    job.schedule,
    'Editing a prompt preserves multiple times and working hours',
  );
  await click(document.querySelector('[data-testid="automation-run-run-1"]'));
  assert.ok(!requests.some(({ url }) => url.pathname.endsWith('/logs')));
  assert.ok(!requests.some(({ url }) => url.pathname === '/api/sessions/messages'));
  await openSection('Logs & technische Details');
  assert.ok(document.body.textContent?.includes('LOG_SENTINEL'));
  assert.ok(document.body.textContent?.includes('TECHNICAL_SENTINEL'));
  await act(async () => root.unmount());
  root = createRoot(container);
  chatFail = true;
  await mount(<AutomationChatPicker workspaceId="ws-1" agentId="bradley" value="" onChange={() => {}} />);
  await click(document.querySelector('[data-testid="automation-chat-picker"]'));
  assert.ok(document.querySelector('[role="alert"]'));
  chatFail = false;
  await click(button('Erneut versuchen'));
  assert.ok(document.body.textContent?.includes('Project meeting'));
  assert.equal(errors.length, 0, errors.join('\n'));
  await act(async () => root.unmount());
  console.log('automation-ui-test: ok (JSDOM component interactions; no browser automation)');
}
void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    internals._load = originalLoad;
    dom.window.close();
  });
