import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import sharp from 'sharp';

async function importServerModule<T>(specifier: string): Promise<T> {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => (
    request === 'server-only' ? {} : originalLoad(request, parent, isMain)
  );
  try {
    return await import(specifier) as T;
  } finally {
    moduleInternals._load = originalLoad;
  }
}

async function main() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-user-profile-'));
  process.env.DATA = dataRoot;
  delete process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

  try {
    const { runMigrations } = await import('../app/lib/db/migrate');
    const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
    runMigrations(sqlite);
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, image, role, created_at, updated_at)
      VALUES (?, ?, ?, 1, NULL, 'user', ?, ?)
    `).run('profile-user-a', 'Alex Weber', 'alex.weber@example.test', now, now);
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, image, role, created_at, updated_at)
      VALUES (?, ?, ?, 1, NULL, 'user', ?, ?)
    `).run('profile-user-b', 'Berta Beispiel', 'berta@example.test', now, now);

    const { getUserInitials } = await import('../app/lib/user-profile/initials');
    const {
      normalizeUserAvatarIconId,
      USER_AVATAR_ICON_IDS,
    } = await import('../app/lib/user-profile/icon-catalog');
    const storage = await importServerModule<typeof import('../app/lib/user-profile/storage')>(
      '../app/lib/user-profile/storage',
    );
    const service = await importServerModule<typeof import('../app/lib/user-profile/service')>(
      '../app/lib/user-profile/service',
    );

    assert.equal(getUserInitials({ name: 'Alex Weber', locale: 'de' }), 'AW');
    assert.equal(getUserInitials({ name: '  Élodie   van der Meer ', locale: 'de' }), 'ÉM');
    assert.equal(getUserInitials({ name: '李雷', locale: 'zh' }), '李');
    assert.equal(getUserInitials({ name: '', email: 'alex.weber@example.test' }), 'AW');
    assert.equal(getUserInitials({ name: '', email: '' }), '');
    assert.equal(USER_AVATAR_ICON_IDS.length, 12);
    assert.equal(normalizeUserAvatarIconId(' SPARKLES '), 'sparkles');
    assert.equal(normalizeUserAvatarIconId('script-alert'), null);

    const initial = await service.resolveUserProfile({
      userId: 'profile-user-a',
      name: 'Alex Weber',
      email: 'alex.weber@example.test',
    });
    assert.equal(initial.avatarKind, 'initials');
    assert.equal(initial.initials, 'AW');
    assert.equal(initial.revision, 0);

    await service.selectUserProfileIcon({ userId: 'profile-user-a', iconId: 'sparkles' });
    const icon = await service.resolveUserProfile({
      userId: 'profile-user-a',
      name: 'Alex Weber',
      email: 'alex.weber@example.test',
    });
    assert.equal(icon.avatarKind, 'icon');
    assert.equal(icon.iconId, 'sparkles');
    assert.equal(icon.revision, 1);
    await assert.rejects(
      () => service.selectUserProfileIcon({ userId: 'profile-user-a', iconId: '../escape' }),
      service.UserProfileError,
    );

    const source = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 4,
        background: { r: 34, g: 74, b: 120, alpha: 1 },
      },
    }).webp({ quality: 88 }).toBuffer();
    await service.saveUserProfileImage({ userId: 'profile-user-a', buffer: source });
    const image = await service.resolveUserProfile({
      userId: 'profile-user-a',
      name: 'Alex Weber',
      email: 'alex.weber@example.test',
    });
    assert.equal(image.avatarKind, 'image');
    assert.equal(image.imageUrl, '/api/account/profile/avatar?v=2');
    assert.deepEqual((await service.readUserProfileImage('profile-user-a'))?.buffer, source);
    const databaseImage = sqlite.prepare('SELECT image FROM user WHERE id = ?').get('profile-user-a') as { image: string | null };
    assert.equal(databaseImage.image, '/api/account/profile/avatar?v=2');

    const profileDir = path.join(dataRoot, 'users', 'profile-user-a', 'profile');
    assert.equal((await stat(profileDir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(profileDir, 'avatar.webp'))).mode & 0o777, 0o600);
    const appearanceJson = JSON.parse(await readFile(path.join(profileDir, 'appearance.json'), 'utf8')) as { avatarKind: string };
    assert.equal(appearanceJson.avatarKind, 'image');

    const bInitial = await service.resolveUserProfile({
      userId: 'profile-user-b',
      name: 'Berta Beispiel',
      email: 'berta@example.test',
    });
    assert.equal(bInitial.avatarKind, 'initials');
    assert.equal(bInitial.revision, 0);

    const mutations = await Promise.all([
      service.selectUserProfileIcon({ userId: 'profile-user-a', iconId: 'rocket' }),
      service.selectUserProfileIcon({ userId: 'profile-user-a', iconId: 'leaf' }),
      service.selectUserProfileIcon({ userId: 'profile-user-a', iconId: 'coffee' }),
    ]);
    assert.deepEqual(mutations.map((entry) => entry.revision).sort((a, b) => a - b), [3, 4, 5]);
    assert.equal((await service.resolveUserProfile({ userId: 'profile-user-a', name: 'Alex Weber' })).revision, 5);

    await service.selectUserProfileInitials('profile-user-a');
    assert.equal((await service.resolveUserProfile({ userId: 'profile-user-a', name: 'Alex Weber' })).avatarKind, 'initials');
    assert.equal((sqlite.prepare('SELECT image FROM user WHERE id = ?').get('profile-user-a') as { image: string | null }).image, null);
    await assert.rejects(() => readFile(path.join(profileDir, 'avatar.webp')), { code: 'ENOENT' });

    await writeFile(path.join(profileDir, 'appearance.json'), '{not json', 'utf8');
    const corruptFallback = await service.resolveUserProfile({ userId: 'profile-user-a', name: 'Alex Weber' });
    assert.equal(corruptFallback.avatarKind, 'initials');
    assert.equal(corruptFallback.revision, 0);

    await service.saveUserProfileImage({ userId: 'profile-user-a', buffer: source });
    await unlink(storage.resolveUserProfileAvatarPath('profile-user-a'));
    const missingImageFallback = await service.resolveUserProfile({ userId: 'profile-user-a', name: 'Alex Weber' });
    assert.equal(missingImageFallback.avatarKind, 'initials');

    assert.throws(() => storage.resolveUserProfileDirectory('../profile-user-a'), /Invalid userId/u);
    sqlite.close();
    console.log('user-profile-service-test: ok');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
