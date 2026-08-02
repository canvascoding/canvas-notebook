import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  licenseProductVariant,
  normalizeLicenseProductClaims,
  type LicenseCert,
} from '../app/lib/license/types';

function certificate(overrides: Partial<LicenseCert> = {}): LicenseCert {
  return {
    sub: 'instance-1',
    plan: 'community',
    ...overrides,
  };
}

function modernCertificate(overrides: Partial<LicenseCert> = {}): LicenseCert {
  return certificate({
    protocolVersion: 'canvas-team-seat-protocol-v1',
    hostingMode: 'community',
    edition: 'solo',
    licenseClass: 'commercial',
    licenseEnvironment: 'production',
    seatLimit: 1,
    ...overrides,
  });
}

for (const expected of [
  { hostingMode: 'community', edition: 'solo', variant: 'community-solo' },
  { hostingMode: 'community', edition: 'team', variant: 'community-team' },
  { hostingMode: 'cloud', edition: 'solo', variant: 'cloud-solo' },
  { hostingMode: 'cloud', edition: 'team', variant: 'cloud-team' },
] as const) {
  const product = normalizeLicenseProductClaims(modernCertificate({
    plan: expected.hostingMode === 'cloud' ? 'managed' : 'community',
    hostingMode: expected.hostingMode,
    edition: expected.edition,
    seatLimit: expected.edition === 'team' ? 4 : 1,
  }));
  assert.ok(product);
  assert.equal(licenseProductVariant(product), expected.variant);
}

for (const licenseClass of ['commercial', 'manual', 'test'] as const) {
  const product = normalizeLicenseProductClaims(modernCertificate({
    licenseClass,
    licenseEnvironment: licenseClass === 'commercial' ? 'production' : 'staging',
  }));
  assert.ok(product);
  assert.equal(product.licenseClass, licenseClass);
  assert.equal(product.licenseEnvironment, licenseClass === 'commercial' ? 'production' : 'staging');
}

assert.deepEqual(normalizeLicenseProductClaims(certificate()), {
  protocolVersion: 'legacy',
  hostingMode: 'community',
  edition: 'solo',
  licenseClass: 'commercial',
  licenseEnvironment: 'production',
  seatLimit: 1,
});

assert.deepEqual(normalizeLicenseProductClaims(certificate({
  plan: 'managed',
  deploymentMode: 'managed-single',
})), {
  protocolVersion: 'legacy',
  hostingMode: 'cloud',
  edition: 'solo',
  licenseClass: 'commercial',
  licenseEnvironment: 'production',
  seatLimit: 1,
});

assert.deepEqual(normalizeLicenseProductClaims(certificate({
  plan: 'managed',
  deploymentMode: 'managed-team',
  quotas: { users: 8 },
})), {
  protocolVersion: 'legacy',
  hostingMode: 'cloud',
  edition: 'team',
  licenseClass: 'commercial',
  licenseEnvironment: 'production',
  seatLimit: 8,
});

assert.deepEqual(normalizeLicenseProductClaims(certificate({
  plan: 'pro',
  quotas: { maxTeamMembers: 5 },
})), {
  protocolVersion: 'legacy',
  hostingMode: 'community',
  edition: 'team',
  licenseClass: 'commercial',
  licenseEnvironment: 'production',
  seatLimit: 5,
});

for (const seatLimit of [0, -1, 1.5, Number.NaN, '4']) {
  assert.equal(
    normalizeLicenseProductClaims(modernCertificate({ seatLimit: seatLimit as number })),
    null,
  );
}

assert.equal(normalizeLicenseProductClaims(modernCertificate({ hostingMode: 'private' })), null);
assert.equal(normalizeLicenseProductClaims(modernCertificate({ edition: 'enterprise' })), null);
assert.equal(normalizeLicenseProductClaims(modernCertificate({ licenseClass: 'internal' })), null);
assert.equal(normalizeLicenseProductClaims(modernCertificate({ licenseEnvironment: 'local' })), null);
assert.equal(normalizeLicenseProductClaims(modernCertificate({ protocolVersion: 'canvas-team-seat-protocol-v2' })), null);
assert.equal(normalizeLicenseProductClaims(modernCertificate({ edition: undefined })), null);

const licenseTypesSource = readFileSync(
  path.join(process.cwd(), 'app/lib/license/types.ts'),
  'utf8',
);
assert.doesNotMatch(
  licenseTypesSource,
  /(stripe[A-Za-z]*Id|priceId|customerId|subscriptionId|unitAmount|immediateAmount|recurringAmount)/u,
);

console.log('License domain normalization checks passed.');
