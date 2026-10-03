import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import type { TeamSeatHealth } from '../app/lib/license/team-seat-health-types';
import messages from '../messages/en.json';
import germanMessages from '../messages/de.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.test/en/settings', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'Element', 'Node', 'MutationObserver',
  'CustomEvent', 'Event', 'MouseEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

const fixture: TeamSeatHealth = {
  mode: 'managed-team', organizationId: 'organization', generatedAt: '2026-09-30T10:00:00Z',
  historicalCommunity: { pendingOperations: 1, failedOperations: 6 },
  license: { class: 'manual', environment: 'production', seatLimit: 10,
    expiresAt: '2026-09-30T11:00:00Z', termEndsAt: '2027-09-30T11:00:00Z', nonBillable: true, billingMode: 'manual_grant' },
  claim: { state: 'idle', connectionExpiresAt: null, reconnectReason: null },
  sync: { state: 'healthy', managedState: 'current', lastAttemptAt: '2026-09-30T10:00:00Z', lastError: null,
    membershipRevision: 5, entitlementsVersion: 7, blocker: null, observedQuantity: 2, approvedQuantity: 2,
    billedQuantity: null, licensedQuantity: 10, lastSyncAt: '2026-09-30T10:00:00Z', nextReportAt: '2026-09-30T10:01:00Z',
    staleAfterAt: '2026-09-30T10:02:00Z', driftStatus: null, reconciliationStatus: 'current', reconciliationAction: null,
    reconciliationReason: null, reconciliationSeatLimit: 10, supportRequired: false, pendingOperations: 0,
    failedOperations: 0, oldestPendingAt: null },
  grace: { licenseState: 'active', startedAt: null, expiresAt: null, remainingSeconds: null,
    refreshPhase: null, nextRefreshAt: null, lastRefreshErrorCode: null },
  recovery: { canSyncSnapshot: true, canRefreshLicense: false, reconnectRequired: false, costConfirmationRequired: false },
};

async function main() {
  const { render, fireEvent } = await import('@testing-library/react');
  const { TeamSeatHealthPanel } = await import('../app/components/license/TeamSeatHealthPanel');
  const actions: string[] = [];
  const preferenceUpdates: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/user-preferences') {
      if (init?.method === 'PATCH') preferenceUpdates.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ success: true, data: {} });
    }
    if (String(input) === '/api/license/team/recovery') {
      actions.push(JSON.parse(String(init?.body)).action);
      return Response.json({ success: true });
    }
    throw new Error(`Unexpected request: ${input}`);
  };
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const view = (health: TeamSeatHealth, locale = 'en') => render(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={locale === 'de' ? germanMessages : messages}>
      <TeamSeatHealthPanel health={health} />
    </NextIntlClientProvider>,
  );
  const screen = view(fixture);
  try {
    await settle();
    assert(screen.getByText('Confirmed in sync'));
    assert(screen.getByText('Control Plane connection: Connected'));
    assert(screen.getByText('Active'));
    assert(screen.getByText('Confirmed'));
    assert.equal(screen.getAllByText('2').length, 2);
    assert(screen.getByText('10', { selector: 'p' }));
    assert(screen.getByText('Licensed'));
    assert.equal(screen.queryByText('Offline grace'), null);
    assert.equal(screen.queryByRole('button', { name: 'Refresh license certificate' }), null);
    assert.equal(screen.queryByText('Previous Community operations'), null);
    const details = screen.getByRole('button', { name: 'Expand: Synchronization and license details' });
    assert.equal(details.getAttribute('aria-expanded'), 'false');
    fireEvent.click(details);
    assert.equal(details.getAttribute('aria-expanded'), 'true');
    assert(screen.getByText('Certificate valid until'));
    assert(screen.getByText('Grant valid until'));
    assert(screen.getByText('Not applicable · non-billable'));
    assert.equal(screen.queryByRole('region', { name: 'Previous Community operations' }), null);
    fireEvent.click(details);
    assert.equal(screen.queryByText('Certificate valid until'), null);
    assert.equal(screen.queryByRole('switch'), null);
    const notifications = screen.getByRole('button', { name: 'Expand: Notifications' });
    notifications.focus();
    assert.equal(document.activeElement, notifications);
    assert.equal(notifications.getAttribute('aria-expanded'), 'false');
    fireEvent.click(notifications);
    assert.equal(notifications.getAttribute('aria-expanded'), 'true');
    const inApp = screen.getByRole('switch', { name: 'Show license events in the notification center' });
    const email = screen.getByRole('switch', { name: 'Email for team access changes' });
    fireEvent.click(inApp);
    await settle();
    assert.equal(inApp.getAttribute('aria-checked'), 'false');
    assert.equal(email.getAttribute('aria-checked'), 'true');
    assert.deepEqual(preferenceUpdates, [{ teamLicenseNotificationsEnabled: false }]);
    fireEvent.click(notifications);
    assert.equal(screen.queryByRole('switch'), null);
    fireEvent.click(screen.getByRole('button', { name: 'Sync memberships now' }));
    await settle();
    assert.deepEqual(actions, ['sync_snapshot']);
    assert(screen.getByText('Membership sync was scheduled.'));
  } finally { screen.unmount(); }

  const errorHealth: TeamSeatHealth = { ...fixture,
    claim: { ...fixture.claim, state: 'idle' },
    sync: { ...fixture.sync, state: 'attention', managedState: 'error', lastError: { code: 'MANAGED_TEAM_CONTROL_PLANE_ERROR', endpoint: '/ack', httpStatus: 503 } },
  };
  const failed = view(errorHealth);
  try {
    await settle();
    assert(failed.getByText('Sync failed'));
    assert(failed.getByText('MANAGED_TEAM_CONTROL_PLANE_ERROR'));
    assert.equal(failed.getByRole('button', { name: 'Expand: Synchronization and license details' }).getAttribute('aria-expanded'), 'false');
    assert.equal(failed.queryByText('Confirmed in sync'), null);
  } finally { failed.unmount(); }

  const adoption = view({ ...fixture, sync: { ...fixture.sync, state: 'attention', managedState: 'adoption_required' } }, 'de');
  try {
    await settle();
    assert(adoption.getByText('Adoption erforderlich'));
    assert(adoption.getByText('Die Instanz muss in der Control Plane freigegeben werden.'));
    assert.equal(adoption.getByRole('button', { name: /Synchronisierung und Lizenzdetails/ }).getAttribute('aria-expanded'), 'false');
  } finally { adoption.unmount(); }

  for (const policyState of ['restricted', 'grace'] as const) {
    const policyView = view({ ...fixture,
      managedAccessPolicy: { state: policyState, reason: 'grant_expired', graceEndsAt: '2026-09-30T12:00:00Z' },
      sync: { ...fixture.sync, state: 'attention' },
    });
    try {
      await settle();
      const confirmedBadge = policyView.getByText('Confirmed in sync');
      assert(confirmedBadge.querySelector('.lucide-circle-check'));
      assert(!confirmedBadge.className.includes('bg-destructive'));
      assert(policyView.getByText('Control Plane connection: Connected'));
      assert(policyView.getByText(policyState === 'restricted' ? 'Team access restricted' : 'Team access in grace period'));
      assert(policyView.getByText('The grant has expired.'));
      assert(policyView.getByText('Check and renew or reapprove the grant in the Control Plane, then sync again.'));
      assert.equal(policyView.queryByText('No action required.'), null);
      assert.equal(policyView.getByRole('button', { name: 'Expand: Synchronization and license details' }).getAttribute('aria-expanded'), 'false');
      assert.equal(policyView.queryByText('Offline grace'), null);
      if (policyState === 'grace') assert(policyView.getByText(/Locally signed access remains valid until/));
    } finally { policyView.unmount(); }
  }

  const unknownTerm = view({ ...fixture, license: { ...fixture.license, termEndsAt: null } });
  try {
    await settle();
    fireEvent.click(unknownTerm.getByRole('button', { name: 'Expand: Synchronization and license details' }));
    const termLabel = unknownTerm.getByText('Grant valid until');
    assert.equal(termLabel.parentElement?.querySelector('dd')?.textContent, 'Unavailable');
  } finally { unknownTerm.unmount(); }

  const community = view({ ...fixture, mode: 'community', sync: { ...fixture.sync, managedState: null, lastError: null },
    recovery: { ...fixture.recovery, canRefreshLicense: true, reconnectRequired: true } });
  try {
    await settle();
    assert(community.getByRole('button', { name: 'Refresh license certificate' }));
    assert(community.getByRole('link', { name: 'Repair connection' }));
    assert.equal(community.queryByText('Confirmed in sync'), null);
  } finally { community.unmount(); }

  const grace = view({ ...fixture, grace: { ...fixture.grace, licenseState: 'grace', expiresAt: '2026-09-30T12:00:00Z', remainingSeconds: 3600 } });
  try { await settle(); assert(grace.getByText('Offline grace')); } finally { grace.unmount(); }
  console.info('Managed license panel keeps status and required actions visible, discloses details, and schedules recovery without claiming ACK success');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
