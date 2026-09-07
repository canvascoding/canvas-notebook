export type HomeWidgetEmail = {
  id: string;
  accountId: string;
  accountLabel: string;
  folder?: string;
  from: string;
  subject: string;
  date: string | null;
};

export type HomeWidgetTodo = {
  id: string;
  title: string;
  priority: 'low' | 'normal' | 'high';
  dueAt: string | null;
  readState: 'read' | 'unread';
};

export type HomeWidgetAutomation = {
  id: string;
  name: string;
  status: 'active' | 'paused';
  lastRunAt: string | null;
  lastRunStatus: 'pending' | 'running' | 'success' | 'failed' | 'retry_scheduled' | null;
  nextRunAt: string | null;
  resultText: string | null;
};

export type HomeWidgetStudio = {
  id: string;
  prompt: string;
  createdAt: string;
  status: string;
  output: {
    id: string;
    mediaUrl: string;
    mimeType: string;
  } | null;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type ApiPayload<T> = {
  success?: boolean;
  data?: T;
};

async function readJson<T>(fetcher: Fetcher, input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetcher(input, init);
  const payload = await response.json().catch(() => null) as ApiPayload<T> | null;
  if (!response.ok || !payload?.success || payload.data === undefined) {
    throw new Error('Widget data could not be loaded.');
  }
  return payload.data;
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function loadHomeWidgetEmails(fetcher: Fetcher, signal?: AbortSignal): Promise<HomeWidgetEmail[]> {
  const accountsPayload = await readJson<{ accounts?: Array<{ id?: string; emailAddress?: string; displayName?: string }> }>(
    fetcher,
    '/api/email/accounts',
    { credentials: 'include', cache: 'no-store', signal },
  );
  const accounts = (accountsPayload.accounts ?? []).filter((account): account is { id: string; emailAddress?: string; displayName?: string } => Boolean(account.id));
  if (accounts.length === 0) return [];

  const accountResults = await Promise.allSettled(accounts.map(async (account) => {
    const foldersPayload = await readJson<{ folders?: Array<{ path?: string; role?: string }> }>(
      fetcher,
      `/api/email/folders?accountId=${encodeURIComponent(account.id)}`,
      { credentials: 'include', cache: 'no-store', signal },
    );
    const folder = foldersPayload.folders?.find((candidate) => candidate.role === 'inbox')?.path;
    const messagesPayload = await readJson<{ messages?: Array<{ id?: string; folder?: string; from?: string; subject?: string; date?: string; isRead?: boolean }> }>(
      fetcher,
      '/api/email/messages/list',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        cache: 'no-store',
        signal,
        body: JSON.stringify({ accountId: account.id, ...(folder ? { folder } : {}), filter: 'unread', limit: 3 }),
      },
    );
    const accountLabel = account.displayName?.trim() || account.emailAddress?.trim() || account.id;
    return (messagesPayload.messages ?? [])
      .filter((message): message is typeof message & { id: string } => Boolean(message.id) && message.isRead === false)
      .map((message) => ({
        id: message.id,
        accountId: account.id,
        accountLabel,
        ...(message.folder || folder ? { folder: message.folder || folder } : {}),
        from: message.from?.trim() || '',
        subject: message.subject?.trim() || '',
        date: message.date || null,
      }));
  }));

  if (accountResults.every((result) => result.status === 'rejected')) {
    throw new Error('Email widget data could not be loaded.');
  }
  return accountResults
    .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    .sort((a, b) => timestamp(b.date) - timestamp(a.date))
    .slice(0, 3);
}

export async function loadHomeWidgetTodos(fetcher: Fetcher, workspaceId: string, signal?: AbortSignal): Promise<HomeWidgetTodo[]> {
  const params = new URLSearchParams({ workspaceId, scope: 'workspace', status: 'active', limit: '3' });
  const todos = await readJson<Array<{ id: string; title: string; priority?: string; dueAt?: string | null; readState?: string }>>(
    fetcher,
    `/api/todos?${params}`,
    { credentials: 'include', cache: 'no-store', signal },
  );
  return todos.slice(0, 3).map((todo) => ({
    id: todo.id,
    title: todo.title,
    priority: todo.priority === 'high' || todo.priority === 'low' ? todo.priority : 'normal',
    dueAt: todo.dueAt || null,
    readState: todo.readState === 'unread' ? 'unread' : 'read',
  }));
}

export async function loadHomeWidgetAutomation(fetcher: Fetcher, workspaceId: string, signal?: AbortSignal): Promise<HomeWidgetAutomation | null> {
  const jobs = await readJson<Array<{
    id: string;
    name: string;
    workspaceId?: string | null;
    status: 'active' | 'paused';
    lastRunAt?: string | null;
    lastRunStatus?: HomeWidgetAutomation['lastRunStatus'];
    nextRunAt?: string | null;
    updatedAt?: string;
  }>>(fetcher, '/api/automations/jobs', { credentials: 'include', cache: 'no-store', signal });
  const job = jobs
    .filter((candidate) => candidate.workspaceId === workspaceId)
    .sort((a, b) => timestamp(b.lastRunAt || b.updatedAt) - timestamp(a.lastRunAt || a.updatedAt))[0];
  if (!job) return null;

  let resultText: string | null = null;
  try {
    const runs = await readJson<Array<{ createdAt?: string; resultText?: string | null }>>(
      fetcher,
      `/api/automations/jobs/${encodeURIComponent(job.id)}/runs`,
      { credentials: 'include', cache: 'no-store', signal },
    );
    resultText = [...runs].sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt))[0]?.resultText?.trim() || null;
  } catch (error) {
    if (signal?.aborted) throw error;
  }

  return {
    id: job.id,
    name: job.name,
    status: job.status,
    lastRunAt: job.lastRunAt || null,
    lastRunStatus: job.lastRunStatus || null,
    nextRunAt: job.nextRunAt || null,
    resultText,
  };
}

export async function loadHomeWidgetStudio(fetcher: Fetcher, workspaceId: string, signal?: AbortSignal): Promise<HomeWidgetStudio | null> {
  const params = new URLSearchParams({ workspaceId, limit: '1' });
  const response = await fetcher(`/api/studio/generations?${params}`, { credentials: 'include', cache: 'no-store', signal });
  const payload = await response.json().catch(() => null) as {
    success?: boolean;
    generations?: Array<{
      id: string;
      prompt?: string;
      createdAt?: string;
      status?: string;
      outputs?: Array<{ id: string; mediaUrl?: string; mimeType?: string }>;
    }>;
  } | null;
  if (!response.ok || !payload?.success || !Array.isArray(payload.generations)) {
    throw new Error('Studio widget data could not be loaded.');
  }
  const generation = payload.generations[0];
  if (!generation) return null;
  const output = generation.outputs?.find((candidate) => candidate.mimeType?.startsWith('image/') && candidate.mediaUrl) ?? null;
  return {
    id: generation.id,
    prompt: generation.prompt?.trim() || '',
    createdAt: generation.createdAt || '',
    status: generation.status || '',
    output: output ? { id: output.id, mediaUrl: output.mediaUrl!, mimeType: output.mimeType || 'image/*' } : null,
  };
}
