import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createDesktopUpdater } from './updater.mjs';

function createFixture({ packaged = true, responses = [] } = {}) {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => ({ updateInfo: { version: '2026.8.17.1' } });
  updater.downloadUpdate = async () => undefined;
  updater.quitAndInstall = () => {};
  const messages = [];
  const dialog = {
    showMessageBox: async options => {
      messages.push(options);
      return { response: responses.shift() ?? 1 };
    },
  };
  const scheduled = [];
  const service = createDesktopUpdater({
    app: { isPackaged: packaged },
    autoUpdater: updater,
    dialog,
    getParentWindow: () => null,
    logger: { error: () => {} },
    setTimeoutFn: callback => scheduled.push(callback),
  });

  return { updater, messages, scheduled, service };
}

test('configures signed release updates only for packaged applications', () => {
  const { updater, service } = createFixture();

  assert.equal(service.configure(), true);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);

  const unpackaged = createFixture({ packaged: false });
  assert.equal(unpackaged.service.configure(), false);
});

test('downloads and installs only after explicit confirmation', async () => {
  const { updater, messages, service } = createFixture({ responses: [0, 0] });
  const downloads = [];
  let installs = 0;
  updater.downloadUpdate = async () => downloads.push('downloaded');
  updater.quitAndInstall = () => { installs += 1; };
  service.configure();

  updater.emit('update-available', { version: '2026.8.17.1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages[0].title, 'Update available');
  assert.deepEqual(downloads, ['downloaded']);

  updater.emit('update-downloaded', { version: '2026.8.17.1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages[1].title, 'Update ready');
  assert.equal(installs, 1);
});

test('schedules one non-interactive update check after app startup', () => {
  const { scheduled, service } = createFixture();
  service.configure();
  service.scheduleInitialCheck();

  assert.equal(scheduled.length, 1);
});
