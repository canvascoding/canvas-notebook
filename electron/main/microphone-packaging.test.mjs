import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const audioInputEntitlement = 'com.apple.security.device.audio-input';

test('macOS dictation declares microphone access for the app and helper processes', async () => {
  const mac = packageJson.build.mac;
  assert.equal(mac.hardenedRuntime, true);
  assert.match(mac.extendInfo.NSMicrophoneUsageDescription, /dictation/i);

  // electron-builder discovers these files in its build resources directory.
  const resources = packageJson.build.directories.buildResources ?? 'build';
  const files = [mac.entitlements ?? `${resources}/entitlements.mac.plist`,
    mac.entitlementsInherit ?? `${resources}/entitlements.mac.inherit.plist`];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/,
      `${file} must grant audio input under Hardened Runtime; a live track can otherwise contain only silence.`);
  }
});

const bundlePath = process.env.CANVAS_ELECTRON_MAC_TEST_BUNDLE;
test('signed macOS bundle retains microphone access in the app and every helper', {
  skip: !bundlePath && 'Set CANVAS_ELECTRON_MAC_TEST_BUNDLE to verify a packaged macOS app.',
}, async () => {
  assert.equal(process.platform, 'darwin');
  assert.ok(path.isAbsolute(bundlePath));
  const parsePlist = input => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    input, encoding: 'utf8',
  }));
  const info = parsePlist(await readFile(path.join(bundlePath, 'Contents/Info.plist')));
  assert.equal(info.NSMicrophoneUsageDescription, packageJson.build.mac.extendInfo.NSMicrophoneUsageDescription);
  const frameworks = path.join(bundlePath, 'Contents/Frameworks');
  const helpers = (await readdir(frameworks)).filter(name => name.endsWith('.app'));
  assert.ok(helpers.length > 0, 'The packaged app must contain Electron helpers.');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundlePath], { stdio: 'pipe' });
  for (const appPath of [bundlePath, ...helpers.map(name => path.join(frameworks, name))]) {
    const entitlements = parsePlist(execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', appPath], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }));
    assert.equal(entitlements[audioInputEntitlement], true, `${appPath} must have signed audio-input access.`);
    const signingInfo = spawnSync('/usr/bin/codesign', ['-d', '--verbose', appPath], { encoding: 'utf8' });
    assert.equal(signingInfo.status, 0, signingInfo.stderr);
    assert.match(signingInfo.stderr, /flags=.*\bruntime\b/, `${appPath} must use Hardened Runtime.`);
  }
});
