import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import JSZip from 'jszip';

type Kind = 'plugin' | 'skill';
type Offering = { name: string; displayName: string; description: string; latestVersion: string;
  versions: Record<string, { version: string; downloadUrl: string; checksum: string }> };
type Registry = { schemaVersion: 1; id: string; name: string; updatedAt: string; plugins: Offering[]; skills: Offering[] };
type Barrier = { requested: Promise<void>; release(): void };

/** Real, isolated HTTP transport; the application and its authority services are never simulated. */
export async function createPackageStoreRegistryFixture(root: string) {
  const registries = new Map<string, Registry>();
  const archives = new Map<string, Buffer>();
  const statuses = new Map<string, number>();
  const requests = new Map<string, number>();
  const barriers = new Map<string, { requested(): void; released: Promise<void>; release(): void }>();
  const activeReleases = new Set<() => void>();
  let baseUrl = '';
  const ensure = (origin: string): Registry => {
    assert.match(origin, /^[a-z][a-z0-9-]{0,31}$/u);
    let registry = registries.get(origin);
    if (!registry) {
      registry = { schemaVersion: 1, id: `store-${origin}`, name: `Fixture store ${origin}`, updatedAt: '2026-10-07T00:00:00Z', plugins: [], skills: [] };
      registries.set(origin, registry);
    }
    return registry;
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', baseUrl);
      const registryMatch = /^\/registry\/([a-z][a-z0-9-]*)$/u.exec(url.pathname);
      if (registryMatch) {
        const origin = registryMatch[1];
        requests.set(`registry:${origin}`, (requests.get(`registry:${origin}`) || 0) + 1);
        const registry = ensure(origin), status = statuses.get(origin) || 200;
        const body = status === 200 ? JSON.stringify(registry) : JSON.stringify({ error: 'Controlled registry unavailable.' });
        const barrier = barriers.get(origin);
        if (barrier) {
          barriers.delete(origin); activeReleases.add(barrier.release); barrier.requested();
          await barrier.released; activeReleases.delete(barrier.release);
        }
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(body);
        return;
      }
      const archive = archives.get(url.pathname);
      if (archive) {
        requests.set('archive', (requests.get('archive') || 0) + 1);
        response.writeHead(200, { 'content-type': 'application/zip', 'content-length': archive.length }); response.end(archive);
        return;
      }
      response.writeHead(404); response.end();
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    registryUrl(origin: string): string { ensure(origin); return `${baseUrl}/registry/${origin}?fixture-config=${origin}#full-config-identity`; },
    setRegistryId(origin: string, id: string): void { ensure(origin).id = id; },
    setStatus(origin: string, status: number): void { assert(Number.isSafeInteger(status) && status >= 100 && status <= 599); statuses.set(origin, status); },
    setDigest(origin: string, kind: Kind, name: string, version: string, checksum: string): void {
      assert.match(checksum, /^[a-f0-9]{64}$/u);
      const offering = ensure(origin)[kind === 'plugin' ? 'plugins' : 'skills'].find(value => value.name === name);
      assert(offering?.versions[version]); offering.versions[version].checksum = checksum;
    },
    setLatest(origin: string, kind: Kind, name: string, version: string): void {
      const offering = ensure(origin)[kind === 'plugin' ? 'plugins' : 'skills'].find(value => value.name === name);
      assert(offering?.versions[version]); offering.latestVersion = version;
    },
    async addPackage(origin: string, kind: Kind, name: string, version: string, files: Readonly<Record<string, string | Buffer>>,
      checksum: (directory: string) => Promise<string>) {
      assert.match(name, /^[a-z0-9][a-z0-9-]*$/u); assert.match(version, /^\d+\.\d+\.\d+$/u);
      const directory = path.join(root, 'sources', origin, kind, name, version), archive = new JSZip();
      for (const [relative, bytes] of Object.entries(files)) {
        assert(!path.isAbsolute(relative) && !relative.split('/').includes('..') && !relative.includes('\\'));
        const target = path.join(directory, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); archive.file(relative, bytes);
      }
      const digest = await checksum(directory), archiveUrl = `/archives/${origin}/${kind}/${name}/${version}.zip`;
      archives.set(archiveUrl, await archive.generateAsync({ type: 'nodebuffer' }));
      const list = ensure(origin)[kind === 'plugin' ? 'plugins' : 'skills'];
      let offering = list.find(value => value.name === name);
      if (!offering) { offering = { name, displayName: name, description: 'Controlled public offering', latestVersion: version, versions: {} }; list.push(offering); }
      offering.versions[version] = { version, downloadUrl: `${baseUrl}${archiveUrl}?fixture-download=private-display-guard`, checksum: digest };
      offering.latestVersion = version;
      return { directory, checksum: digest };
    },
    holdNextRegistry(origin: string): Barrier {
      ensure(origin); assert(!barriers.has(origin));
      let requested!: () => void, release!: () => void;
      const received = new Promise<void>(resolve => { requested = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
      barriers.set(origin, { requested, released, release });
      return { requested: received, release };
    },
    count(key: string): number { return requests.get(key) || 0; },
    resetCounts(): void { requests.clear(); },
    async close(): Promise<void> {
      for (const barrier of barriers.values()) barrier.release(); barriers.clear();
      for (const release of activeReleases) release();
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
