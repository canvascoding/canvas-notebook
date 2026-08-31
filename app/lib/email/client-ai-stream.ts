export type EmailAiStreamStage = 'reading_context' | 'writing' | 'ready';

export type EmailComposeAgentStreamEvent = {
  type: string;
  [key: string]: unknown;
};

type EmailSummaryStreamEvent =
  | { type: 'start'; messageId?: string }
  | { type: 'status'; stage?: EmailAiStreamStage; label?: string }
  | { type: 'delta'; delta: string }
  | { type: 'done'; summary?: string }
  | { type: 'error'; error: string };

type EmailAiDraftStreamEvent =
  | { type: 'status'; stage?: EmailAiStreamStage; label?: string }
  | { type: 'delta'; delta: string }
  | { type: 'done'; body?: string }
  | { type: 'error'; message: string };

function parseStreamData(rawEvent: string): string {
  return rawEvent
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();
}

function parseEmailAiStreamStage(value: unknown): EmailAiStreamStage | undefined {
  return value === 'reading_context' || value === 'writing' || value === 'ready' ? value : undefined;
}

function parseEmailSummaryStreamEvent(rawEvent: string): EmailSummaryStreamEvent | null {
  const data = parseStreamData(rawEvent);
  if (!data) return null;

  const parsed = JSON.parse(data) as Partial<EmailSummaryStreamEvent>;
  if (parsed.type === 'start') return { type: 'start', messageId: typeof parsed.messageId === 'string' ? parsed.messageId : undefined };
  if (parsed.type === 'status') {
    return {
      type: 'status',
      label: typeof parsed.label === 'string' ? parsed.label : undefined,
      stage: parseEmailAiStreamStage(parsed.stage),
    };
  }
  if (parsed.type === 'delta' && typeof parsed.delta === 'string') return { type: 'delta', delta: parsed.delta };
  if (parsed.type === 'done') return { type: 'done', summary: typeof parsed.summary === 'string' ? parsed.summary : undefined };
  if (parsed.type === 'error' && typeof parsed.error === 'string') return { type: 'error', error: parsed.error };
  return null;
}

function parseEmailAiDraftStreamEvent(rawEvent: string): EmailAiDraftStreamEvent | null {
  const data = parseStreamData(rawEvent);
  if (!data) return null;

  const parsed = JSON.parse(data) as Partial<EmailAiDraftStreamEvent>;
  if (parsed.type === 'status') {
    return {
      type: 'status',
      label: typeof parsed.label === 'string' ? parsed.label : undefined,
      stage: parseEmailAiStreamStage(parsed.stage),
    };
  }
  if (parsed.type === 'delta' && typeof parsed.delta === 'string') return { type: 'delta', delta: parsed.delta };
  if (parsed.type === 'done') return { type: 'done', body: typeof parsed.body === 'string' ? parsed.body : undefined };
  if (parsed.type === 'error' && typeof parsed.message === 'string') return { type: 'error', message: parsed.message };
  return null;
}

function parseEmailComposeAgentStreamEvent(rawEvent: string): EmailComposeAgentStreamEvent | null {
  const data = parseStreamData(rawEvent);
  if (!data) return null;

  const parsed = JSON.parse(data) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const event = parsed as Record<string, unknown>;
  return typeof event.type === 'string' ? { ...event, type: event.type } : null;
}

export async function readEmailSummaryStream(
  response: Response,
  onDelta: (delta: string) => void,
  onStatus?: (stage: EmailAiStreamStage | undefined, label: string | undefined) => void,
): Promise<string> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(String((payload as { error?: unknown }).error || 'Failed to summarize email message'));
  }

  if (!response.body) throw new Error('Email summary stream did not return a readable body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let summary = '';

  const processEvent = (rawEvent: string) => {
    const event = parseEmailSummaryStreamEvent(rawEvent);
    if (!event || event.type === 'start') return;
    if (event.type === 'status') {
      onStatus?.(event.stage, event.label);
      return;
    }
    if (event.type === 'delta') {
      summary += event.delta;
      onDelta(event.delta);
      return;
    }
    if (event.type === 'done') {
      if (event.summary) summary = event.summary;
      return;
    }
    if (event.type === 'error') throw new Error(event.error);
  };

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const event of events) processEvent(event);
    if (done) break;
  }

  if (buffer.trim()) processEvent(buffer);
  return summary;
}

export async function readEmailAiDraftStream(
  response: Response,
  handlers: {
    onDelta?: (delta: string, body: string) => void;
    onStatus?: (stage: EmailAiStreamStage | undefined, label: string | undefined) => void;
  } = {},
): Promise<string> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(String((payload as { error?: unknown }).error || 'Failed to generate email text'));
  }

  if (!response.body) throw new Error('Email AI stream did not return a readable body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let body = '';

  const processEvent = (rawEvent: string) => {
    const event = parseEmailAiDraftStreamEvent(rawEvent);
    if (!event) return;
    if (event.type === 'status') {
      handlers.onStatus?.(event.stage, event.label);
      return;
    }
    if (event.type === 'delta') {
      body += event.delta;
      handlers.onDelta?.(event.delta, body);
      return;
    }
    if (event.type === 'done') {
      if (event.body) body = event.body;
      return;
    }
    if (event.type === 'error') throw new Error(event.message);
  };

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const event of events) processEvent(event);
    if (done) break;
  }

  if (buffer.trim()) processEvent(buffer);
  return body;
}

export async function readEmailComposeAgentStream(
  response: Response,
  onEvent: (event: EmailComposeAgentStreamEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error('Email compose agent stream did not return a readable body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const processEvent = (rawEvent: string) => {
    const event = parseEmailComposeAgentStreamEvent(rawEvent);
    if (event) onEvent(event);
  };

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const event of events) processEvent(event);
    if (done) break;
  }

  if (buffer.trim()) processEvent(buffer);
}
