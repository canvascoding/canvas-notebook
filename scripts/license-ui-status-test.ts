import assert from 'node:assert/strict';
import { isLicenseUiStatus } from '../app/lib/license/ui-policy';

type StatusFixture = Record<string, unknown>;

function selfHostedStatus(): StatusFixture {
  return {
    success: true,
    licensed: true,
    plan: 'community',
    instanceId: 'license-ui-status-instance',
    runtimeDeploymentMode: 'community-selfhosted',
    edition: 'solo',
    expiresAt: '2030-01-01T12:00:00.000Z',
  };
}

function healthFixture(): StatusFixture {
  return {
    license: {},
    sync: {},
    claim: {},
    grace: {},
    recovery: {},
  };
}

const cases: Array<[string, unknown, boolean]> = [
  ['active self-hosted Solo', selfHostedStatus(), true],
  ['unregistered self-hosted Solo', {
    ...selfHostedStatus(), licensed: false, plan: 'unregistered', expiresAt: null,
  }, true],
  ['self-hosted Team', { ...selfHostedStatus(), edition: 'team', teamSeatHealth: healthFixture() }, true],
  ['Managed Team', {
    ...selfHostedStatus(), plan: 'managed', runtimeDeploymentMode: 'managed-team', edition: 'team',
    teamSeatHealth: healthFixture(),
  }, true],
  ['Managed Solo without certificate', {
    ...selfHostedStatus(), plan: 'managed', runtimeDeploymentMode: 'managed-single',
    licensed: false, expiresAt: null,
  }, true],
  ['normalized Managed mode', { ...selfHostedStatus(), runtimeDeploymentMode: '  MANAGED_TEAM  ' }, true],
  ['legacy hosting mode', {
    ...selfHostedStatus(), runtimeDeploymentMode: undefined, hostingMode: 'cloud',
  }, true],
  ['legacy deployment mode', {
    ...selfHostedStatus(), runtimeDeploymentMode: undefined, deploymentMode: 'managed-team',
  }, true],
  ['legacy plan fallback', { ...selfHostedStatus(), runtimeDeploymentMode: undefined }, true],
  ['ordinary license validation error is valid status', {
    ...selfHostedStatus(), licensed: false, error: 'license_expired',
  }, true],
  ['expired certificate is valid status', {
    ...selfHostedStatus(), licensed: false, expiresAt: '2000-01-01T00:00:00.000Z',
  }, true],
  ['date with timezone offset', { ...selfHostedStatus(), expiresAt: '2030-01-01T14:00:00+02:00' }, true],
  ['Date-parseable date string', { ...selfHostedStatus(), expiresAt: '2030-01-01' }, true],
  ['optional expiration omitted', { ...selfHostedStatus(), expiresAt: undefined }, true],
  ['optional health null', { ...selfHostedStatus(), teamSeatHealth: null }, true],
  ['optional health undefined', { ...selfHostedStatus(), teamSeatHealth: undefined }, true],
  ['extra server metadata', {
    ...selfHostedStatus(), code: 'LICENSE_VALID', databaseProvider: 'postgres',
  }, true],
  ['HTTP 200 empty JSON', {}, false],
  ['missing payload', undefined, false],
  ['null payload', null, false],
  ['array payload', [], false],
  ['array containing valid payload', [selfHostedStatus()], false],
  ['string payload', 'license status', false],
  ['boolean payload', true, false],
  ['number payload', 42, false],
  ['unavailable status despite otherwise complete fields', {
    ...selfHostedStatus(), error: 'license_status_unavailable',
  }, false],
  ['unavailable status with inactive license', {
    ...selfHostedStatus(), licensed: false, error: 'license_status_unavailable',
  }, false],
];

for (const field of ['success', 'licensed', 'plan', 'instanceId']) {
  const status = selfHostedStatus();
  delete status[field];
  cases.push([`missing required ${field}`, status, false]);
}

for (const value of [false, null, undefined, 'true', 1, {}, []]) {
  cases.push([`invalid success ${JSON.stringify(value)}`, { ...selfHostedStatus(), success: value }, false]);
}
for (const value of [null, undefined, 'true', 'false', 0, 1, {}, []]) {
  cases.push([`invalid licensed ${JSON.stringify(value)}`, { ...selfHostedStatus(), licensed: value }, false]);
}
for (const field of ['plan', 'instanceId']) {
  for (const value of ['', '   ', '\t\n', null, undefined, 1, true, {}, []]) {
    cases.push([`invalid ${field} ${JSON.stringify(value)}`, { ...selfHostedStatus(), [field]: value }, false]);
  }
}

for (const field of ['runtimeDeploymentMode', 'hostingMode', 'deploymentMode']) {
  for (const value of [42, true, {}, [], ['managed-team']]) {
    cases.push([`invalid hosting field ${field} ${JSON.stringify(value)}`, {
      ...selfHostedStatus(), [field]: value,
    }, false]);
  }
}

for (const value of ['', 'not-a-date', '2030-13-01T00:00:00.000Z', '2030-01-01T25:00:00.000Z',
  0, 1, true, {}, [], ['2030-01-01'], new Date('2030-01-01')]) {
  cases.push([`invalid expiration ${JSON.stringify(value)}`, { ...selfHostedStatus(), expiresAt: value }, false]);
}

for (const value of [false, 0, 'healthy', [], [{}], {}]) {
  cases.push([`invalid health ${JSON.stringify(value)}`, { ...selfHostedStatus(), teamSeatHealth: value }, false]);
}
for (const field of ['license', 'sync', 'claim', 'grace', 'recovery']) {
  const missing = healthFixture();
  delete missing[field];
  cases.push([`health missing ${field}`, { ...selfHostedStatus(), teamSeatHealth: missing }, false]);
  for (const value of [undefined, null, false, 0, 'healthy', [], [{}]]) {
    cases.push([`invalid health ${field} ${JSON.stringify(value)}`, {
      ...selfHostedStatus(), teamSeatHealth: { ...healthFixture(), [field]: value },
    }, false]);
  }
}

for (const [label, value, expected] of cases) {
  let actual: boolean | undefined;
  assert.doesNotThrow(() => { actual = isLicenseUiStatus(value); }, `${label}: malformed input must not throw`);
  assert.equal(actual, expected, label);
}

console.log(`License UI status tests passed (${cases.length} cases).`);
