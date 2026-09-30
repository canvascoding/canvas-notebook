import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvas-license-notification-preference-'));
  const previousData = process.env.DATA;
  process.env.DATA = dataDir;
  try {
    const { getUserPreferences, updateUserPreferences } = await import('../app/lib/user-preferences');
    const ownerId = 'license-notification-owner';
    assert.equal((await getUserPreferences(ownerId)).teamLicenseNotificationsEnabled, undefined);
    assert.equal((await updateUserPreferences(ownerId, {
      teamLicenseNotificationsEnabled: false,
    })).teamLicenseNotificationsEnabled, false);
    assert.equal((await getUserPreferences(ownerId)).teamLicenseNotificationsEnabled, false);
    assert.equal((await updateUserPreferences(ownerId, {
      teamLicenseNotificationsEnabled: true,
    })).teamLicenseNotificationsEnabled, true);
    assert.equal((await getUserPreferences(ownerId)).teamLicenseNotificationsEnabled, true);
    assert.equal((await getUserPreferences(ownerId)).teamLicenseEmailNotificationsEnabled, undefined);
    assert.equal((await updateUserPreferences(ownerId, {
      teamLicenseEmailNotificationsEnabled: false,
    })).teamLicenseEmailNotificationsEnabled, false);
    assert.equal((await getUserPreferences(ownerId)).teamLicenseNotificationsEnabled, true);
    assert.equal((await updateUserPreferences(ownerId, {
      teamLicenseEmailNotificationsEnabled: true,
    })).teamLicenseEmailNotificationsEnabled, true);
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await rm(dataDir, { recursive: true, force: true });
  }
  console.info('team license notification preference persisted per user');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
