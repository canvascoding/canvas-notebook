import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION } from '../app/lib/email/classification/settings-types';
import { projectEmailClassification } from '../app/lib/email/classification/policy';
import type { EmailClassificationAdminSettings } from '../app/lib/email/classification/admin-service';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLFormElement', 'Element', 'Node', 'MutationObserver', 'Event', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

function snapshot(revision = 1): EmailClassificationAdminSettings {
  return {
    execution: { mode: 'direct', reason: null, managed: null },
    settings: { revision, configuration: structuredClone(DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION), updatedAt: null, updatedByUserId: null },
    availability: { enabled: false, available: false, revision, defaultMode: 'classic', reason: 'disabled' },
    credentials: { status: 'configured', configured: true, scope: 'system', anonymous: false, settingsLink: '/settings?tab=secrets' },
    providerOptions: [{ id: 'typesafe', label: 'TypeSafe Jev', requiresEndpoint: false, defaultModel: 'jev-1.13.0', credentialKeyDefault: 'TYPESAFE_API_KEY' },
      { id: 'systemone', label: 'System One compatible', requiresEndpoint: true, defaultModel: 'kev', credentialKeyDefault: 'EMAIL_CLASSIFICATION_API_KEY' },
      { id: 'openai-decisions', label: 'OpenAI Decisions', requiresEndpoint: false, defaultModel: 'gpt-6-luna', credentialKeyDefault: 'OPENAI_API_KEY' }],
    health: { state: 'paused', counts: { indexed: 9, analyzed: 5, pending: 2, processing: 1, failed: 1 },
      mailboxes: { active: 2, pending: 0, partial: 1, complete: 1, failed: 0, lastSyncAt: null },
      budget: { dayStart: 0, resetsAt: 86_400_000, used: 5, remaining: 1995, limit: 2000 }, usage: null, averageLatencyMs: null, lastCompletedAt: null },
  };
}

async function main() {
  const { render, fireEvent, cleanup } = await import('@testing-library/react');
  const { EmailClassificationSettingsCard } = await import('../app/components/settings/EmailClassificationSettingsCard');
  const originalFetch = globalThis.fetch;
  const settingsEvents: unknown[] = [];
  const onSaved = (event: Event) => settingsEvents.push((event as CustomEvent).detail);
  window.addEventListener('canvas-email-classification-settings-updated', onSaved);
  const writes: Array<{ expectedRevision: number; configuration: EmailClassificationAdminSettings['settings']['configuration'] }> = [];
  const probes: Array<{ configuration: EmailClassificationAdminSettings['settings']['configuration'] }> = [];
  const pendingReads: Array<(response: Response) => void> = [];
  let server = snapshot();
  let deferRead = false;
  let denyRead = false;
  let failProbe = false;
  let refuseProbe = false;
  let managedBudget = false;
  const privateMessage = 'PRIVATE_PROVIDER_OR_SECRET_VALUE_MUST_NEVER_RENDER';
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    assert.equal(init?.credentials, 'include');
    if (url.pathname === '/api/admin/email-classification/test') {
      probes.push(JSON.parse(String(init?.body)));
      if (managedBudget) return Response.json({ success: false, code: 'EMAIL_CLASSIFICATION_MANAGED_BUDGET_EXHAUSTED', error: privateMessage }, { status: 402 });
      if (refuseProbe) return Response.json({ success: false, code: 'EMAIL_CLASSIFICATION_REFUSED', error: privateMessage }, { status: 502 });
      if (failProbe) return Response.json({ success: false, code: 'EMAIL_CLASSIFICATION_INVALID_RESPONSE', error: privateMessage }, { status: 502 });
      return Response.json({ success: true, data: { success: true, providerId: probes.at(-1)!.configuration.providerId, model: probes.at(-1)!.configuration.model,
        latencyMs: 42, classification: projectEmailClassification({ raw: null }), ratings: { spamProbability: 0.02, replyProbability: 0.9 } } });
    }
    assert.equal(url.pathname, '/api/admin/email-classification/settings', 'The card never reads an ENV snapshot or secret value');
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as (typeof writes)[number]; writes.push(body);
      if (body.expectedRevision !== server.settings.revision) return Response.json({ success: false, code: 'EMAIL_CLASSIFICATION_VERSION_CONFLICT', error: privateMessage }, { status: 409 });
      server = { ...server, settings: { ...server.settings, revision: server.settings.revision + 1, configuration: body.configuration },
        availability: { ...server.availability, revision: server.settings.revision + 1, enabled: body.configuration.enabled, defaultMode: body.configuration.enabled ? 'focus' : 'classic' } };
      return Response.json({ success: true, data: server });
    }
    if (denyRead) return Response.json({ success: false, error: privateMessage }, { status: 403 });
    if (deferRead) { deferRead = false; return new Promise<Response>(resolve => pendingReads.push(resolve)); }
    return Response.json({ success: true, data: server });
  };
  const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const wrap = (locale: 'en' | 'de' = 'en') => <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de} timeZone="UTC"><EmailClassificationSettingsCard /></NextIntlClientProvider>;
  try {
    const view = render(wrap()); await tick();
    const enable = view.getByRole('switch', { name: 'Enable for everyone' });
    assert.equal(enable.getAttribute('aria-checked'), 'false');
    assert(view.getByText(en.emailClassificationSettings.selectionHint));
    assert.equal(enable.closest('[data-slot="collapsible-content"]'), null, 'Central activation stays outside the collapsed configuration');
    assert.equal(view.queryByLabelText('Model'), null, 'Provider details start hidden');
    fireEvent.click(view.getByRole('button', { name: 'Provider and configuration' }));
    const model = view.getByLabelText('Model') as HTMLInputElement;
    assert.equal(view.getByLabelText(en.emailClassificationSettings.limits.initialLookbackDays).getAttribute('max'), '30');
    fireEvent.change(model, { target: { value: 'jev-draft' } });
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Test draft' })); });
    assert.equal(probes[0].configuration.enabled, false); assert.equal(probes[0].configuration.model, 'jev-draft');
    assert.equal(writes.length, 0, 'Testing a disabled unsaved draft never saves or activates it');
    assert.equal(view.getAllByText('Unconfirmed').length, 2, 'Unknown category/priority are not fabricated as other/normal');
    assert.equal(view.getByRole('link', { name: 'Manage system Secrets' }).getAttribute('href'), '/settings?tab=secrets');
    assert.equal(view.container.querySelector('input[type="password"]'), null, 'Only a credential name is editable here');

    const provider = view.getByLabelText('Provider');
    fireEvent.change(provider, { target: { value: 'systemone' } });
    fireEvent.change(view.getByLabelText(en.emailClassificationSettings.endpoint), { target: { value: 'http://127.0.0.1:11434/v1/systemone' } });
    fireEvent.change(provider, { target: { value: 'openai-decisions' } });
    assert.equal(model.value, 'gpt-6-luna');
    assert.equal((view.getByLabelText('System credential name') as HTMLInputElement).value, 'OPENAI_API_KEY');
    assert.equal(view.queryByLabelText(en.emailClassificationSettings.endpoint), null, 'OpenAI uses its fixed native Decisions endpoint');
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Test draft' })); });
    assert.equal(probes.at(-1)!.configuration.providerId, 'openai-decisions');
    assert.equal(probes.at(-1)!.configuration.model, 'gpt-6-luna');
    assert.equal(probes.at(-1)!.configuration.credentialKey, 'OPENAI_API_KEY');
    assert.equal(probes.at(-1)!.configuration.endpoint, null, 'A custom compatible endpoint cannot carry over to OpenAI');
    assert.equal(probes.at(-1)!.configuration.allowPrivateNetwork, false);
    assert.equal(probes.at(-1)!.configuration.enabled, false);
    assert.equal(writes.length, 0, 'Provider selection and probing leave the saved provider and activation unchanged');
    refuseProbe = true;
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Test draft' })); });
    assert(view.getByText('The provider declined to assess the sample email. Review the criteria or choose another provider.'));
    assert.equal(view.container.textContent?.includes(privateMessage), false);
    refuseProbe = false;
    fireEvent.change(provider, { target: { value: 'typesafe' } });
    fireEvent.change(model, { target: { value: 'jev-draft' } });

    deferRead = true;
    await act(async () => { window.dispatchEvent(new CustomEvent('canvas_secrets_updated')); });
    assert.equal(pendingReads.length, 1);
    fireEvent.change(model, { target: { value: 'jev-preserved' } });
    await act(async () => { pendingReads.pop()!(Response.json({ success: true, data: { ...server, credentials: { ...server.credentials, status: 'missing', configured: false } } })); });
    assert.equal(model.value, 'jev-preserved', 'A late Secrets refresh never overwrites an edited model');
    assert.equal(view.queryByText('Sample evaluated in 42 ms'), null, 'An old probe does not claim to validate an edited draft');
    failProbe = true;
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Test draft' })); });
    assert(view.getByText('The provider did not return a valid assessment for the sample.'));
    assert.equal(view.container.textContent?.includes(privateMessage), false, 'Provider errors use safe localized copy');
    failProbe = false;

    server = snapshot(2); server.settings.configuration.model = 'jev-other-admin';
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save settings' })); });
    assert.equal(writes[0].expectedRevision, 1); assert.equal(writes[0].configuration.model, 'jev-preserved');
    assert.equal(model.value, 'jev-preserved', 'CAS conflict keeps the draft for review');
    assert(view.getByText('The saved configuration has changed. Reload before saving.'));
    fireEvent.change(model, { target: { value: 'jev-still-preserved' } });
    assert(view.getByText('The saved configuration has changed. Reload before saving.'), 'Editing after conflict cannot silently clear it');
    assert.deepEqual(settingsEvents, []);
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Reload saved configuration' })); });
    assert.equal(model.value, 'jev-other-admin', 'Only explicit reload discards the old draft and adopts the new revision');
    fireEvent.click(enable);
    assert.equal(writes.length, 1, 'The enable switch only edits the draft');
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save settings' })); });
    assert.equal(writes[1].expectedRevision, 2); assert.equal(writes[1].configuration.enabled, true);
    assert.deepEqual(settingsEvents, [{ enabled: true, revision: 3 }], 'Availability event contains only safe activation/revision fields');
    assert(view.getByText('Settings saved.')); assert(view.getByText('Enabled'));
    assert.equal(view.container.textContent?.includes(privateMessage), false);
    cleanup();

    denyRead = true;
    const denied = render(wrap('de')); await tick();
    assert(denied.getByText('Nur Serveradministratoren können die E-Mail-Vorbereitung verwalten.'));
    assert.equal((denied.getByRole('switch', { name: 'Für alle aktivieren' }) as HTMLButtonElement).disabled, true);
    assert.equal(denied.container.textContent?.includes(privateMessage), false, 'Denied API details are never rendered');
    assert.equal(denied.queryByLabelText('Modell'), null);
    cleanup(); denyRead = false;
    server = snapshot(10);
    const profile = { ref: 'central-jev', name: 'Central Jev', providerId: 'typesafe', model: 'jev-1.13.0', inferenceRevision: `sha256:${'a'.repeat(64)}`, adapterVersion: 'fixture', status: 'ready' as const, available: true, timeoutMs: 30000,
      capabilities: { questionTypes: ['choice', 'binary'] as const, simultaneousQuestions: true, choiceProbabilities: 'required' as const, ordinalProbabilities: 'required' as const, binaryProbabilities: true, maxChoices: 255, maxOrdinalLevels: 10, maxStateBytes: 131072, maxRequestBytes: 262144, probabilitySemantics: 'model_probability' as const } };
    server.settings.configuration.executionMode = 'managed'; server.settings.configuration.managedModelRef = profile.ref;
    server.settings.configuration.managedModel = { ref: profile.ref, providerId: profile.providerId, model: profile.model, inferenceRevision: profile.inferenceRevision, adapterVersion: profile.adapterVersion };
    server.credentials = { ...server.credentials, status: 'missing', configured: false };
    server.execution = { mode: 'managed', reason: null, managed: { status: 'ready', code: null, catalog: { contractVersion: 1, catalogRevision: profile.inferenceRevision, defaultModelRef: profile.ref, models: [profile, { ...profile, ref: 'central-second', name: 'Second decision model' }] } } };
    const managed = render(wrap('de')); await tick();
    assert(managed.getByText(de.emailClassificationSettings.managed.title));
    assert(managed.getByLabelText(de.emailClassificationSettings.managed.model));
    assert.equal(managed.queryByLabelText(de.emailClassificationSettings.credential), null);
    assert.equal(managed.queryByText(de.emailClassificationSettings.availability.missing_configuration), null, 'Managed readiness never demands a local system key.');
    fireEvent.click(managed.getByRole('button', { name: de.emailClassificationSettings.configuration }));
    assert.equal(managed.queryByLabelText(de.emailClassificationSettings.credential), null, 'Even expanded managed details contain no local key form.');
    fireEvent.change(managed.getByLabelText(de.emailClassificationSettings.managed.model), { target: { value: 'central-second' } });
    managedBudget = true;
    await act(async () => { fireEvent.click(managed.getByRole('button', { name: de.emailClassificationSettings.testAction })); });
    assert.equal(probes.at(-1)!.configuration.executionMode, 'managed');
    assert.equal(probes.at(-1)!.configuration.managedModelRef, 'central-second');
    assert.equal(probes.at(-1)!.configuration.enabled, false);
    assert(managed.getByText(de.emailClassificationSettings.errors.managedBudget));
    assert.equal(managed.container.textContent?.includes(privateMessage), false);
    fireEvent.change(managed.getByLabelText(de.emailClassificationSettings.deliveryMode), { target: { value: 'direct' } });
    assert(managed.getByLabelText(de.emailClassificationSettings.credential));
    fireEvent.change(managed.getByLabelText(de.emailClassificationSettings.deliveryMode), { target: { value: 'managed' } });
    assert.equal(managed.queryByLabelText(de.emailClassificationSettings.credential), null);
    console.log('Email classification settings UI passed: central switch, progressive disclosure, disabled OpenAI/Jev draft probes, fixed OpenAI endpoint/model/System Secret defaults, safe refusal, Secrets race protection, CAS preservation/reload and localized failures.');
  } finally {
    cleanup(); globalThis.fetch = originalFetch; window.removeEventListener('canvas-email-classification-settings-updated', onSaved); dom.window.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
