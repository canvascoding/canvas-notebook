// Real desktop runtime acceptance; uses only owned loopback HTTP/TLS fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { _electron, expect } from '@playwright/test';
import electronExecutable from 'electron';
const expectedVersion = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).devDependencies.electron;

async function main() {
  process.umask(0o077);
  const owned = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-electron-security-'));
  const evidence = process.env.CANVAS_SECURITY_ELECTRON_EVIDENCE_DIR;
  if (evidence) {
    assert(path.isAbsolute(evidence));
    await fs.mkdir(evidence, { recursive: true });
  }
  const servers = [];
  let desktop;
  try {
    const key = path.join(owned, 'fixture.key');
    const cert = path.join(owned, 'fixture.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
      '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'pipe' });
    const handler = (request, response) => {
      if (request.url === '/api/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      } else {
        response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'" });
        response.end('<!doctype html><title>Owned desktop fixture</title><h1>Desktop connection accepted</h1>');
      }
    };
    const httpServer = http.createServer(handler);
    const tlsServer = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, handler);
    for (const server of [httpServer, tlsServer]) {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      servers.push(server);
    }
    const origin = `http://127.0.0.1:${httpServer.address().port}`;
    const untrusted = `https://127.0.0.1:${tlsServer.address().port}`;
    const wrapper = path.join(owned, 'main.mjs');
    const profile = path.join(owned, 'profile');
    await fs.mkdir(profile);
    await fs.writeFile(wrapper, `import { app } from 'electron';\napp.setPath('userData', ${JSON.stringify(profile)});\nawait import(${JSON.stringify(pathToFileURL(path.resolve('electron/main/main.mjs')).href)});\n`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const launch = () => _electron.launch({ executablePath: electronExecutable, args: [wrapper], env });
    desktop = await launch();
    const actualVersion = await desktop.evaluate(() => process.versions.electron);
    assert.equal(actualVersion, expectedVersion);
    let page = await desktop.firstWindow();
    await expect(page.locator('#server-url')).toBeVisible();
    if (evidence) await page.screenshot({ path: path.join(evidence, 'electron-setup.png') });
    await page.locator('#server-url').fill('file:///etc/passwd');
    await page.locator('#connect-button').click();
    await expect(page.locator('#status-title')).toHaveText('Check the server URL');
    await page.locator('#server-url').fill(untrusted);
    await page.locator('#connect-button').click();
    await expect(page.locator('#status-title')).toHaveText('Secure connection could not be verified');
    const chromiumTls = await desktop.evaluate(async ({ BrowserWindow }, url) => {
      const isolated = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false } });
      try { await isolated.loadURL(url); return 'unexpectedly accepted'; }
      catch (error) { return error.message; }
      finally { isolated.destroy(); }
    }, untrusted);
    assert.match(chromiumTls, /ERR_CERT_AUTHORITY_INVALID/);
    await page.locator('#server-url').fill(origin);
    await page.locator('#connect-button').click();
    await expect(page.locator('h1')).toHaveText('Desktop connection accepted');
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    const preferences = await desktop.evaluate(({ BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox };
    });
    assert.deepEqual(preferences, { nodeIntegration: false, contextIsolation: true, sandbox: true });
    const remoteIpc = await page.evaluate(async url => {
      try { await window.canvasDesktop.setServerUrl(url); return 'unexpectedly accepted'; }
      catch (error) { return error.message; }
    }, origin);
    assert.match(remoteIpc, /only available from the connection setup screen/);
    if (evidence) await page.screenshot({ path: path.join(evidence, 'electron-connected.png') });
    await desktop.close(); desktop = undefined;
    desktop = await launch();
    page = await desktop.firstWindow();
    await expect(page.locator('h1')).toHaveText('Desktop connection accepted');
    console.log(`Electron ${actualVersion}: real setup/connect/relaunch, Node and Chromium TLS rejection, sandbox and IPC boundary passed`);
  } finally {
    try { if (desktop) await desktop.close(); }
    finally {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      await fs.rm(owned, { recursive: true, force: true });
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
