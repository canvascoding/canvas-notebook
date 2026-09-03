import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function main() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-terminal-settings-'));
  const previousDataRoot = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  try {
    const { readTerminalAvailability, serverPreferencesPath, subscribeTerminalAvailability } = await import('../app/lib/terminal-policy');
    const { default: manifest } = await import('../app/manifest');
    const { getServerSettings, setTerminalEnabled, setServerPreferredTimeZone } = await import('../app/lib/server-settings');
    assert.equal(readTerminalAvailability().terminalEnabled, false, 'missing settings default to disabled');
    assert(!manifest().shortcuts?.some(shortcut => shortcut.url === '/terminal'));
    await mkdir(path.dirname(serverPreferencesPath()), { recursive: true });
    for (const contents of ['broken json', '{}', '{"settings":null}', '{"settings":{"terminalEnabled":"true"}}']) {
      await writeFile(serverPreferencesPath(), contents);
      assert.equal(readTerminalAvailability().terminalEnabled, false, contents);
    }
    await writeFile(serverPreferencesPath(), JSON.stringify({ version: 1, settings: { timeZone: 'Europe/Berlin' } }));
    assert.equal(readTerminalAvailability().terminalEnabled, false, 'existing installations default to disabled');
    await setTerminalEnabled('admin-1', true);
    assert.equal(readTerminalAvailability().terminalEnabled, true);
    assert(manifest().shortcuts?.some(shortcut => shortcut.url === '/terminal'));
    assert.equal((await getServerSettings()).timeZone, 'Europe/Berlin');
    assert.equal((await getServerSettings()).terminalUpdatedBy, 'admin-1');
    await setServerPreferredTimeZone('admin-1', 'UTC');
    assert.equal(readTerminalAvailability().terminalEnabled, true, 'other setting updates preserve terminal policy');
    await assert.rejects(setTerminalEnabled('admin-1', 'true' as unknown as boolean));
    const changed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { stop(); reject(new Error('policy notification missing')); }, 3000);
      const stop = subscribeTerminalAvailability(state => {
        if (!state.terminalEnabled) {
          clearTimeout(timeout);
          stop();
          resolve();
        }
      });
    });
    await setTerminalEnabled('admin-2', false);
    await changed;
    const saved = JSON.parse(await readFile(serverPreferencesPath(), 'utf8'));
    assert.equal(saved.settings.terminalEnabled, false);
    assert(!manifest().shortcuts?.some(shortcut => shortcut.url === '/terminal'));
    assert.equal(saved.settings.timeZone, 'UTC');
    assert.equal(saved.settings.terminalUpdatedBy, 'admin-2');
    console.log('terminal-settings-test: ok');
  } finally {
    if (previousDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
