import assert from 'node:assert/strict';
import { licenseHostingVariant } from '../app/lib/license/ui-policy';

assert.equal(licenseHostingVariant(null), null);
assert.equal(licenseHostingVariant({}), null);
assert.equal(licenseHostingVariant({ runtimeDeploymentMode: 'managed-team', plan: 'unregistered' }), 'managed');
assert.equal(licenseHostingVariant({ runtimeDeploymentMode: 'managed_single', hostingMode: null }), 'managed');
assert.equal(licenseHostingVariant({ hostingMode: 'cloud' }), 'managed');
assert.equal(licenseHostingVariant({ plan: 'managed' }), 'managed');
assert.equal(licenseHostingVariant({ runtimeDeploymentMode: 'team', hostingMode: 'cloud' }), 'self-hosted');
assert.equal(licenseHostingVariant({ runtimeDeploymentMode: 'enterprise-onprem', hostingMode: 'community' }), 'self-hosted');
assert.equal(licenseHostingVariant({ hostingMode: 'community', plan: 'community' }), 'self-hosted');
console.info('license UI hosting mode: configured runtime, unavailable certificate, legacy payload, and self-hosted variants passed');
