/** Root explicitly launches this private HTTPS fixture; importing it does not contact a provider or mutate application SQL. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { computeCanvasPluginChecksum } from '../../app/lib/plugins/canvas-plugin-registry';
import { validateCompleteCapabilityPackage } from '../../app/lib/capabilities/packages/artifacts';

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPwd3v6HwAE3AJ67pkOGgAAAABJRU5ErkJggg==', 'base64');

async function main(): Promise<void> {
  if (process.env.CANVAS_MOBILE_PLUGIN_FIXTURE !== '1' || !process.env.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT
    || !path.isAbsolute(process.env.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT)) {
    throw new Error('Explicit fixture authorization and an absolute owned intake root are required.');
  }
  const parent = await fs.realpath(process.env.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT);
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('The configured intake is not a real directory.');
  const nonce = randomBytes(5).toString('hex'), name = `package-editor-qa-${nonce}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `canvas-mobile-plugin-https-${nonce}-`));
  await fs.chmod(directory, 0o700);
  const sourceDirectory = await fs.mkdtemp(path.join(parent, `${name}-`));
  await fs.chmod(sourceDirectory, 0o700);
  const sourceIdentity = await fs.lstat(sourceDirectory, { bigint: true });
  let exposed = false;
  let server: https.Server | undefined;
  try {
    const privateReadmeMarker = `Private package README ${nonce}; this content must never appear in extension metadata.`;
    const files = new Map<string, Buffer>([
      ['.canvas-plugin/plugin.json', Buffer.from(JSON.stringify({ name, version: '1.0.0', description: 'Owned mobile plugin access fixture',
        skills: 'skills', interface: { icon: 'assets/icon.png' } }))],
      ['README.md', Buffer.from(`${privateReadmeMarker}\n`)],
      ['assets/icon.png', TINY_PNG],
      [`skills/${name}-context/SKILL.md`, Buffer.from(`---\nname: ${name}-context\ndescription: Owned mobile access fixture context\nmetadata:\n  version: 1.0.0\n---\nThis fixture contains no executable code or provider integration.\n`)],
    ]);
    const zip = new JSZip();
    // Empty directories belong to the complete archive, including the mandatory empty skills root.
    await fs.mkdir(path.join(sourceDirectory, 'skills'), { mode: 0o700 });
    zip.folder('skills');
    for (const [relative, bytes] of files) {
      const destination = path.join(sourceDirectory, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
      zip.file(relative, bytes);
    }
    const validation = await validateCompleteCapabilityPackage('plugin', sourceDirectory, { name, version: '1.0.0' });
    const checksum = await computeCanvasPluginChecksum(sourceDirectory);
    if (validation.name !== name || validation.version !== '1.0.0' || validation.checksum !== checksum)
      throw new Error('The owned fixture package changed after complete validation.');
    const resolvedPath = await fs.realpath(sourceDirectory), identity = await fs.lstat(sourceDirectory, { bigint: true });
    if (identity.dev !== sourceIdentity.dev || identity.ino !== sourceIdentity.ino || path.dirname(resolvedPath) !== parent
      || (Number(identity.mode) & 0o777) !== 0o700) throw new Error('The owned source identity changed during preparation.');
    const proof = { resolvedPath, parentPath: parent, device: identity.dev.toString(), inode: identity.ino.toString(), mode: 0o700, checksum };
    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const key = path.join(directory, 'key.pem'), certificate = path.join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', certificate], { stdio: 'ignore' });
    await fs.chmod(key, 0o600); await fs.chmod(certificate, 0o600);
    const registryId = `mobile-plugin-${nonce}`;
    let base = '';
    server = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(certificate) }, (request, response) => {
      const url = new URL(request.url || '/', base);
      if (url.pathname === '/registry.json') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ schemaVersion: 1, id: registryId, name: 'Owned mobile access Store', updatedAt: new Date().toISOString(),
          plugins: [{ name, displayName: name, description: 'Owned mobile plugin access fixture', latestVersion: '1.0.0',
            versions: { '1.0.0': { version: '1.0.0', checksum, downloadUrl: `${base}/archive.zip` } } }], skills: [] }));
      } else if (url.pathname === '/archive.zip') {
        response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': archive.length, 'Cache-Control': 'no-store' });
        response.end(archive);
      } else { response.writeHead(404); response.end(); }
    });
    const activeServer = server;
    await new Promise<void>((resolve, reject) => { activeServer.once('error', reject); activeServer.listen(0, '127.0.0.1', resolve); });
    const address = activeServer.address();
    if (!address || typeof address === 'string') throw new Error('The own fixture did not acquire its loopback port.');
    base = `https://127.0.0.1:${address.port}`;
    const proofFile = path.join(directory, 'source-proof.json'), fixtureFile = path.join(directory, 'fixture.json');
    await fs.writeFile(proofFile, JSON.stringify({ nonce, name, proof }), { mode: 0o600, flag: 'wx' });
    await fs.writeFile(fixtureFile, JSON.stringify({ nonce, name, sourceDirectory, sourceParent: parent, proofFile, certificate,
      registryUrl: `${base}/registry.json?owned-mobile=${nonce}`, fixtureDirectory: directory, fixturePid: process.pid,
      imageSha256: createHash('sha256').update(TINY_PNG).digest('hex'), privateReadmeMarker,
      sources: [{ kind: 'plugin', registryId, entryKey: name, version: '1.0.0', checksum }] }), { mode: 0o600, flag: 'wx' });
    exposed = true;
    console.info(`OWN_MOBILE_PLUGIN_HTTPS_READY ${nonce}\nMOBILE_PLUGIN_ACCESS_FIXTURE=${fixtureFile}`);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
      if (stopping) return; stopping = true;
      activeServer.closeAllConnections(); activeServer.close(() => { process.exitCode = 0; });
      // The receipted package cleanup owns the source after exposure; stopping the server never deletes it.
    });
  } catch {
    server?.closeAllConnections(); server?.close();
    if (!exposed) {
      const now = await fs.lstat(sourceDirectory, { bigint: true }).catch(() => null);
      if (now?.isDirectory() && !now.isSymbolicLink() && now.dev === sourceIdentity.dev && now.ino === sourceIdentity.ino
        && path.dirname(sourceDirectory) === parent && path.basename(sourceDirectory).startsWith(`${name}-`)) {
        await fs.rm(sourceDirectory, { recursive: true, force: true });
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
    throw new Error('The private mobile plugin fixture could not be prepared; no application mutation was performed.');
  }
}

void main().catch(() => { console.error('Private mobile plugin fixture preparation failed.'); process.exitCode = 1; });
