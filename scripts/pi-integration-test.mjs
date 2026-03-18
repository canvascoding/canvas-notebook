const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
const loginEmail = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const loginPassword = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : null;
  return { response, body };
}

function getCookieHeader(response) {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);

  if (!setCookies.length) {
    return '';
  }

  return setCookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

async function signIn() {
  console.log(`[PI Test] Signing in as ${loginEmail}...`);
  const login = await request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl,
    },
    body: JSON.stringify({
      email: loginEmail,
      password: loginPassword,
    }),
  });

  if (!login.response.ok) {
    throw new Error(`Login failed: ${login.response.status}`);
  }

  const cookie = getCookieHeader(login.response);
  if (!cookie) {
    throw new Error('Missing auth cookies');
  }

  console.log('[PI Test] Signed in successfully.');
  return cookie;
}

async function testConfig(cookie) {
  console.log('[PI Test] Testing /api/agents/config...');
  const getCfg = await request('/api/agents/config', { headers: { cookie } });
  if (!getCfg.response.ok) throw new Error('GET config failed');
  console.log('[PI Test] Config engine:', getCfg.body.data.engine);

  const piConfig = getCfg.body.data.piConfig;
  const putCfg = await request('/api/agents/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ piConfig: { ...piConfig, updatedAt: new Date().toISOString() } }),
  });
  if (!putCfg.response.ok) throw new Error('PUT config failed');
  console.log('[PI Test] Config update successful.');
}

async function testManagedFiles(cookie) {
  console.log('[PI Test] Testing /api/agents/files...');
  const list = await request('/api/agents/files', { headers: { cookie } });
  if (!list.response.ok || !list.body?.data?.files?.['AGENTS.md']) {
    throw new Error('GET agent files failed');
  }

  const marker = `PI_PROMPT_MARKER_${Date.now()}`;
  const currentContent = list.body.data.files['AGENTS.md'];
  const nextContent = `${currentContent.trim()}\n\n- Integration marker: ${marker}\n`;

  const update = await request('/api/agents/files', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      fileName: 'AGENTS.md',
      content: nextContent,
    }),
  });
  if (!update.response.ok || !update.body?.data?.content?.includes(marker)) {
    throw new Error('PUT agent file failed');
  }

  const doctor = await request('/api/agents/doctor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ livePing: true }),
  });
  if (!doctor.response.ok) {
    throw new Error('Doctor request failed');
  }

  const promptDiagnostics = doctor.body?.data?.promptDiagnostics;
  if (!promptDiagnostics) {
    throw new Error('Doctor response missing prompt diagnostics');
  }

  if (!Array.isArray(promptDiagnostics.includedFiles) || !promptDiagnostics.includedFiles.includes('AGENTS.md')) {
    throw new Error('Prompt diagnostics do not include AGENTS.md');
  }

  if (promptDiagnostics.usedFallback) {
    throw new Error(`Prompt diagnostics unexpectedly used fallback (${promptDiagnostics.fallbackReason || 'unknown'})`);
  }

  console.log('[PI Test] Managed files check passed.');
}

async function testSessions(cookie) {
  console.log('[PI Test] Testing /api/sessions...');
  // Create
  const create = await request('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ title: 'Integration PI Session' }),
  });
  if (!create.response.ok) throw new Error('Session creation failed');
  const sessionId = create.body.session.sessionId;
  console.log('[PI Test] Created session:', sessionId);

  // List
  const list = await request('/api/sessions', { headers: { cookie } });
  if (!list.response.ok) throw new Error('Session listing failed');
  const found = list.body.sessions.find(s => s.sessionId === sessionId);
  if (!found) throw new Error('Created session not found in list');

  // Rename
  const patch = await request('/api/sessions', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ sessionId, title: 'Renamed PI Session' }),
  });
  if (!patch.response.ok) throw new Error('Session rename failed');

  return sessionId;
}

async function testStream(cookie, sessionId) {
  console.log('[PI Test] Testing /api/stream (with 30s timeout)...');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${baseUrl}/api/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'echo hello' }],
        sessionId,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Stream request failed: ${response.status} - ${errorText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let hasText = false;
    let hasAgentEnd = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          hasText = true;
        }
        if (event.type === 'agent_end') {
          hasAgentEnd = true;
        }
      }
    }

    if (!hasText) console.warn('[PI Test] WARNING: Stream did not return any text deltas (maybe missing API key?)');
    if (!hasAgentEnd) throw new Error('Stream did not return agent_end event');
    console.log('[PI Test] Stream check passed.');
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Stream request timed out after 30s');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function testSessionPersistence(cookie, sessionId) {
  console.log('[PI Test] Testing persisted PI session messages...');
  const result = await request(`/api/sessions/messages?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: { cookie },
  });

  if (!result.response.ok) {
    throw new Error(`Failed to load session messages: ${result.response.status}`);
  }

  if (!result.body?.success || !Array.isArray(result.body.messages)) {
    throw new Error('Invalid session messages payload');
  }

  const messages = result.body.messages;
  if (messages.length === 0) {
    throw new Error('Expected persisted PI messages, got empty list');
  }

  const hasUserMessage = messages.some((m) => m.role === 'user');
  const hasAssistantMessage = messages.some((m) => m.role === 'assistant');
  if (!hasUserMessage || !hasAssistantMessage) {
    throw new Error('Persisted session is missing user/assistant messages');
  }

  console.log(`[PI Test] Persistence check passed (${messages.length} messages).`);

  return messages;
}

async function testRuntimeStatusAndCompact(cookie, sessionId) {
  console.log('[PI Test] Testing /api/stream/status and /api/stream/control compact...');

  const statusResult = await request(`/api/stream/status?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: { cookie },
  });

  if (!statusResult.response.ok || !statusResult.body?.success) {
    throw new Error(`Runtime status failed: ${statusResult.response.status}`);
  }

  const status = statusResult.body.status;
  if (
    typeof status?.contextWindow !== 'number' ||
    typeof status?.estimatedHistoryTokens !== 'number' ||
    typeof status?.availableHistoryTokens !== 'number' ||
    typeof status?.contextUsagePercent !== 'number' ||
    !('lastCompactionAt' in status) ||
    !('lastCompactionKind' in status) ||
    !('lastCompactionOmittedCount' in status)
  ) {
    throw new Error('Runtime status payload missing context metrics');
  }

  const compactResult = await request('/api/stream/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      sessionId,
      action: 'compact',
    }),
  });

  if (!compactResult.response.ok || !compactResult.body?.success) {
    throw new Error(`Runtime compact failed: ${compactResult.response.status}`);
  }

  if (
    typeof compactResult.body?.status?.contextUsagePercent !== 'number' ||
    typeof compactResult.body?.status?.lastCompactionAt !== 'string' ||
    compactResult.body?.status?.lastCompactionKind !== 'manual' ||
    typeof compactResult.body?.status?.lastCompactionOmittedCount !== 'number'
  ) {
    throw new Error('Compact response missing updated runtime compaction status');
  }

  console.log('[PI Test] Runtime status and compact check passed.');
}

async function testUsageAnalytics(cookie, sessionId, persistedMessages) {
  console.log('[PI Test] Testing usage analytics endpoints...');

  const summary = await request('/api/usage/summary?groupBy=day', {
    headers: { cookie },
  });
  if (!summary.response.ok || !summary.body?.success) {
    throw new Error(`Usage summary failed: ${summary.response.status}`);
  }

  if (!summary.body?.totals || typeof summary.body.totals.totalTokens !== 'number') {
    throw new Error('Usage summary payload missing totals');
  }

  const events = await request(`/api/usage/events?sessionQuery=${encodeURIComponent(sessionId)}`, {
    headers: { cookie },
  });
  if (!events.response.ok || !events.body?.success) {
    throw new Error(`Usage events failed: ${events.response.status}`);
  }

  if (!Array.isArray(events.body.rows)) {
    throw new Error('Usage events payload missing rows');
  }

  const assistantWithUsage = persistedMessages.find((message) => {
    if (message.role !== 'assistant' || !message.usage) {
      return false;
    }

    return (
      message.usage.totalTokens > 0 ||
      message.usage.input > 0 ||
      message.usage.output > 0 ||
      message.usage.cacheRead > 0 ||
      message.usage.cacheWrite > 0
    );
  });

  if (assistantWithUsage) {
    const matchingEvent = events.body.rows.find((row) => row.sessionId === sessionId);
    if (!matchingEvent) {
      throw new Error('Expected usage event for persisted assistant usage');
    }
  } else {
    console.warn('[PI Test] WARNING: Persisted assistant message had no tracked usage; skipping strict usage ledger assertion.');
  }

  console.log('[PI Test] Usage analytics check passed.');
}

async function run() {
  try {
    const cookie = await signIn();
    await testConfig(cookie);
    await testManagedFiles(cookie);
    const sessionId = await testSessions(cookie);
    await testStream(cookie, sessionId);
    const persistedMessages = await testSessionPersistence(cookie, sessionId);
    await testRuntimeStatusAndCompact(cookie, sessionId);
    await testUsageAnalytics(cookie, sessionId, persistedMessages);
    console.log('[PI Test] All integration tests passed! 🚀');
  } catch (error) {
    console.error('[PI Test] FAILED:', error.message);
    process.exit(1);
  }
}

run();
