import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { createPackageStoreRegistryFixture } from './helpers/package-store-registry-fixture';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-store-preparation-test-'));
  const environment = {DATA: root, CANVAS_DATA_ROOT: root, CANVAS_MCP_DIRECT_ENABLED: 'false', BASE_URL: 'http://localhost:3001', NODE_ENV: 'test', DATABASE_URL: 'postgresql://127.0.0.1:1/preparation_only'};
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const previousRegistries = [process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL, process.env.CANVAS_SKILL_STORE_REGISTRY_URL];
  const registry = await createPackageStoreRegistryFixture(root);
  process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL = registry.registryUrl('source');
  process.env.CANVAS_SKILL_STORE_REGISTRY_URL = registry.registryUrl('source');
  const database = await createPiTestDatabase(), sql = await database.openDb();
  await sql.run("INSERT INTO \"user\"(id,name,email,role,email_verified,banned,created_at,updated_at) VALUES('seed-reader','Seed Reader','seed-reader@preparation.example.test','user',1,0,1,1)");
  const loader = Module as typeof Module & {_load: (name: string, parent: NodeModule | null, main: boolean) => unknown};
  const original = loader._load;
  loader._load = (name, parent, isMain) => {
    if(name === 'server-only') return {};
    if(name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    return original(name,parent,isMain);
  };
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((request, response) => {
    if (request.url === '/slow') { response.writeHead(200); response.write('first'); return; }
    if (request.url === '/large') { response.writeHead(200); response.end(Buffer.alloc(65)); return; }
    response.writeHead(200); response.end('ok');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  try {
    const {extractBoundedStorePackageArchive: extract, readBoundedStorePackageBytes: download} = await import('../app/lib/plugins/store-package-archive');
    const {readExactPackageInventory} = await import('../app/lib/capabilities/packages/io');
    const origins = await import('../app/lib/capabilities/packages/store-origin');
    const zip = new JSZip(); zip.file('prefix/SKILL.md', 'valid'); zip.file('prefix/scripts/run.js', 'console.log(1)'); zip.file('outside.txt', 'not selected'); zip.folder('prefix/assets');
    const extracted = await extract(await zip.generateAsync({type:'nodebuffer'}), 'prefix', 'skill');
    try {
      assert((await fs.stat(path.join(extracted.packageRoot,'assets'))).isDirectory(), 'explicit empty assets/ parent is retained');
      assert.deepEqual(await fs.readdir(path.join(extracted.packageRoot,'assets')), [], 'explicit empty assets/ directory is retained');
      assert.deepEqual((await readExactPackageInventory(extracted.packageRoot)).files.map(file => file.relativePath), ['scripts/run.js','SKILL.md'].sort((a,b)=>a.localeCompare(b)));
      const inventory = await readExactPackageInventory(extracted.packageRoot);
      const origin = await origins.issueVerifiedCapabilityStoreOrigin({resourceId:'source',registryId:'fixture',registryUrl:'https://example.test/registry',
        kind:'skill',entryKey:'test-skill',version:'1.0.0',upstreamChecksum:inventory.checksum,packageRoot:extracted.packageRoot});
      await fs.writeFile(path.join(extracted.packageRoot,'asset.bin'), Buffer.from([0,255]));
      const next = await origins.rebaseIssuedCapabilityStoreOrigin(origin,{resourceId:'target',packageRoot:extracted.packageRoot});
      assert.equal(next.upstreamChecksum,origin.upstreamChecksum); assert.notEqual(next.baselineChecksum,origin.baselineChecksum);
      assert.equal(next.verifiedAt,origin.verifiedAt); assert.equal(next.relation,'installed'); assert(origins.isIssuedCapabilityStoreOrigin(next,'target'));
      await assert.rejects(origins.rebaseIssuedCapabilityStoreOrigin(structuredClone(origin),{resourceId:'forged',packageRoot:extracted.packageRoot}), /verified Store/);
    } finally { await fs.rm(extracted.tempRoot,{recursive:true,force:true}); }
    const rejectArchive = async (archive: JSZip, expression?: RegExp) => assert.rejects(extract(await archive.generateAsync({type:'nodebuffer',platform:'UNIX'}),undefined,'plugin'),expression ?? /./);
    const traversal = new JSZip(); traversal.file('../outside.txt','bad'); await rejectArchive(traversal);
    const casefold = new JSZip(); casefold.file('Same.txt','a'); casefold.file('same.txt','b'); await rejectArchive(casefold);
    const implicitCollision = new JSZip(); implicitCollision.file('same/file.txt','one',{createFolders:false}); implicitCollision.file('Same/other.txt','two',{createFolders:false}); await rejectArchive(implicitCollision);
    const payloadDirectory = new JSZip(); payloadDirectory.folder('assets'); payloadDirectory.file('file.txt','ok'); const payloadBytes=await payloadDirectory.generateAsync({type:'nodebuffer'});
    for(let offset=0;offset<payloadBytes.length-46;offset++) if(payloadBytes.readUInt32LE(offset)===0x02014b50&&payloadBytes.subarray(offset+46,offset+53).toString()==='assets/') payloadBytes.writeUInt32LE(1,offset+24);
    await assert.rejects(extract(payloadBytes,undefined,'skill'));
    const backslash = new JSZip(); backslash.file('scripts\\run.js','bad'); await rejectArchive(backslash);
    const symlink = new JSZip(); symlink.file('link','/etc/passwd',{unixPermissions:0o120777}); await rejectArchive(symlink);
    const oversized = new JSZip(); oversized.file('large.bin',Buffer.alloc(32*1024*1024+1)); await rejectArchive(oversized,/size limit/);
    const many = new JSZip(); for(let index=0;index<2001;index++) many.file(`file-${index}`, ''); await rejectArchive(many,/size limit/);
    const duplicate = new JSZip(); duplicate.file('a.txt','one'); duplicate.file('b.txt','two');
    const duplicateBytes=await duplicate.generateAsync({type:'nodebuffer'});
    for(let offset=0;offset<duplicateBytes.length-5;offset++) if(duplicateBytes.subarray(offset,offset+5).equals(Buffer.from('b.txt'))) duplicateBytes.write('a.txt',offset);
    await assert.rejects(extract(duplicateBytes,undefined,'skill'));
    // Central-directory size forgery reaches the streaming guard, which removes its private temp root.
    const bomb = new JSZip(); bomb.file('bomb.bin',Buffer.alloc(256*1024)); const bombBytes=await bomb.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
    for(let offset=0;offset<bombBytes.length-46;offset++) if(bombBytes.readUInt32LE(offset)===0x02014b50) bombBytes.writeUInt32LE(1,offset+24);
    const before=new Set((await fs.readdir(os.tmpdir())).filter(name=>name.startsWith('canvas-plugin-store-')));
    await assert.rejects(extract(bombBytes,undefined,'plugin'),/size limit/);
    assert.deepEqual((await fs.readdir(os.tmpdir())).filter(name=>name.startsWith('canvas-plugin-store-')&&!before.has(name)),[],'failed streamed extraction cleans its exact private temp directory');
    const {computeCanvasPluginChecksum} = await import('../app/lib/plugins/canvas-plugin-registry');
    const preparation = await import('../app/lib/plugins/store-package-preparation');
    const receipts = await import('../app/lib/capabilities/packages/store-source');
    const origin = await registry.addPackage('source','skill','prepared-skill','1.0.0', {
      'SKILL.md': '---\nname: prepared-skill\ndescription: Exact prepared skill\nmetadata:\n  version: "1.0.0"\n---\nPrepared skill.\n',
      'scripts/run.py': 'print("ok")\n','assets/data.bin':Buffer.from([0,255,7]),
    },computeCanvasPluginChecksum);
    const selection={kind:'skill' as const,registryId:'store-source',entryKey:'prepared-skill',version:'1.0.0',checksum:origin.checksum,resourceId:'trusted-exact-resource'};
    const receipt=await preparation.prepareVerifiedCanvasSkillStorePackage(selection);
    const privateSource=receipts.getPreparedCapabilityStorePackage(receipt);
    assert.equal(privateSource.validation.valid,true);assert.equal(privateSource.validation.files.length,3);
    assert.equal(privateSource.baselineChecksum,origin.checksum);
    assert(!JSON.stringify(receipt).includes(privateSource.packageRoot),'private source path is absent from receipt');
    await receipts.assertPreparedCapabilityStorePackage(receipt,selection);
    await assert.rejects(receipts.assertPreparedCapabilityStorePackage(structuredClone(receipt),selection),/verified Store/);
    await assert.rejects(preparation.prepareVerifiedCanvasSkillStorePackage({...selection,checksum:'a'.repeat(64)}),/offering changed/);
    await assert.rejects(preparation.prepareVerifiedCanvasSkillStorePackage({...selection,expectedOrigin:{registryIdentity:'b'.repeat(64),version:'1.0.0',upstreamChecksum:origin.checksum}}),/original Store offering changed/);
    const {isCapabilityPackageError}=await import('../app/lib/capabilities/packages/contracts');
    const persistentCounts=async()=>Promise.all(['capability_resources','capability_package_versions','capability_package_states'].map(async table=>sql.get(`SELECT COUNT(*)::int AS count FROM ${table}`)));
    const beforePublication=await persistentCounts(), archiveReads=registry.count('archive');
    registry.setDigest('source','skill','prepared-skill','1.0.0','d'.repeat(64));
    await assert.rejects(receipts.assertPreparedCapabilityStorePackage(receipt,selection),error=>isCapabilityPackageError(error)&&error.status===409&&error.code==='PACKAGE_SOURCE_CHANGED');
    assert.deepEqual(await persistentCounts(),beforePublication,'post-preparation selected digest rewrite causes zero publication writes');
    registry.setDigest('source','skill','prepared-skill','1.0.0',origin.checksum);
    registry.setStatus('source',503);
    await assert.rejects(receipts.assertPreparedCapabilityStorePackage(receipt,selection),error=>isCapabilityPackageError(error)&&error.status===503);
    assert.deepEqual(await persistentCounts(),beforePublication,'source outage fails before publication writes');
    registry.setStatus('source',200);assert.equal(registry.count('archive'),archiveReads,'fresh offering check fetches metadata only');
    const updateOrigin=await registry.addPackage('source','skill','prepared-skill','2.0.0', {
      'SKILL.md':'---\nname: prepared-skill\ndescription: Exact newer skill\nmetadata:\n  version: "2.0.0"\n---\nNewer skill.\n',
    },computeCanvasPluginChecksum);
    const updateSelection={...selection,version:'2.0.0',checksum:updateOrigin.checksum};
    const updateReceipt=await preparation.prepareVerifiedCanvasSkillStorePackage({...updateSelection,expectedOrigin:{registryIdentity:privateSource.storeOrigin.registryIdentity,version:'1.0.0',upstreamChecksum:origin.checksum}});
    try {
      registry.setDigest('source','skill','prepared-skill','1.0.0','e'.repeat(64));
      await assert.rejects(receipts.assertPreparedCapabilityStorePackage(updateReceipt,updateSelection),error=>isCapabilityPackageError(error)&&error.status===409);
      assert.deepEqual(await persistentCounts(),beforePublication,'post-preparation baseline digest rewrite causes zero publication writes');
      registry.setDigest('source','skill','prepared-skill','1.0.0',origin.checksum);
      await receipts.assertPreparedCapabilityStorePackage(updateReceipt,updateSelection);
      const readsBeforeHeld=registry.count('registry:source');
      registry.setStatus('source',503);
      await receipts.assertPreparedCapabilityStorePackage(updateReceipt,updateSelection,{database:sql});
      assert.equal(registry.count('registry:source'),readsBeforeHeld,'held SQL performs zero metadata network requests');
      registry.setStatus('source',200);
    } finally {await receipts.disposePreparedCapabilityStorePackage(updateReceipt);}
    const networkCount=registry.count('registry:source');
    process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL=registry.registryUrl('other');
    await assert.rejects(receipts.assertPreparedCapabilityStorePackage(receipt,selection),/configured Store source changed/);
    assert.equal(registry.count('registry:source'),networkCount,'commit-time source guard performs zero registry requests');
    process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL=registry.registryUrl('source');
    await fs.writeFile(path.join(privateSource.packageRoot,'assets/data.bin'),Buffer.from([0,255,8]));
    await assert.rejects(receipts.assertPreparedCapabilityStorePackage(receipt,selection),/prepared Store package changed/);
    await receipts.disposePreparedCapabilityStorePackage(receipt);await receipts.disposePreparedCapabilityStorePackage(receipt);
    await assert.rejects(fs.stat(privateSource.packageRoot));await assert.rejects(receipts.assertPreparedCapabilityStorePackage(receipt,selection));
    const pluginOrigin=await registry.addPackage('source','plugin','prepared-plugin','1.0.0', {
      '.canvas-plugin/plugin.json':JSON.stringify({name:'prepared-plugin',version:'1.0.0',description:'Exact prepared plugin',skills:'skills'}),
      'skills/prepared-context/SKILL.md':'---\nname: prepared-context\ndescription: Prepared bundled context\n---\nContext.\n',
    },computeCanvasPluginChecksum);
    const pluginSelection={...selection,kind:'plugin' as const,entryKey:'prepared-plugin',checksum:pluginOrigin.checksum};
    const pluginReceipt=await preparation.prepareVerifiedCanvasPluginStorePackage(pluginSelection);
    assert.equal(receipts.getPreparedCapabilityStorePackage(pluginReceipt).validation.valid,true);
    await receipts.assertPreparedCapabilityStorePackage(pluginReceipt,pluginSelection);await receipts.disposePreparedCapabilityStorePackage(pluginReceipt);
    const seedOrigin=await registry.addPackage('source','plugin','prepared-seeds','1.0.0', {
      '.canvas-plugin/plugin.json':JSON.stringify({name:'prepared-seeds',version:'1.0.0',description:'Captured publicly bundled sources',skillRefs:[{name:'docx',source:'seed'}]}),
      'README.md':'Read-authorized seeded package.\n',
    },computeCanvasPluginChecksum);
    const seedSelection={...pluginSelection,entryKey:'prepared-seeds',checksum:seedOrigin.checksum,actor:{userId:'seed-reader'}};
    const originalReadFile=fs.readFile;let originalSeedReads=0;
    fs.readFile=(async (...args:Parameters<typeof fs.readFile>)=>{
      if(String(args[0])===path.join(process.cwd(),'seed_skills','docx','SKILL.md')) originalSeedReads++;
      return originalReadFile(...args);
    }) as typeof fs.readFile;
    try {
      const seeded=await preparation.prepareVerifiedCanvasPluginStorePackage(seedSelection);
      try {
        const source=receipts.getPreparedCapabilityStorePackage(seeded);
        const manifest=JSON.parse(await fs.readFile(path.join(source.packageRoot,'.canvas-plugin/plugin.json'),'utf8'));
        assert.equal(manifest.skillRefs,undefined);assert.equal(manifest.skills,'./skills');
        assert((await fs.stat(path.join(source.packageRoot,'skills','docx','SKILL.md'))).isFile());
        assert.notEqual(source.baselineChecksum,source.upstreamChecksum);
        assert.equal(source.storeOrigin.upstreamChecksum,seedOrigin.checksum);
        assert.equal(source.storeOrigin.baselineChecksum,source.validation.checksum);
        assert.equal(originalSeedReads,0,'original SKILL.md is never parsed before no-follow capture or Read authority');
        await receipts.assertPreparedCapabilityStorePackage(seeded,seedSelection,{database:sql});
        await sql.run('UPDATE "user" SET banned=1 WHERE id=$1',['seed-reader']);
        await assert.rejects(receipts.assertPreparedCapabilityStorePackage(seeded,seedSelection,{database:sql}),/not permitted/);
        await assert.rejects(preparation.prepareVerifiedCanvasPluginStorePackage(seedSelection),/not permitted/);
        assert.equal(originalSeedReads,0,'revoked actor cannot reach the original metadata parser');
        await sql.run('UPDATE "user" SET banned=0 WHERE id=$1',['seed-reader']);
      } finally {await receipts.disposePreparedCapabilityStorePackage(seeded);}
    } finally {fs.readFile=originalReadFile;}
    const base=`http://127.0.0.1:${address.port}`;
    assert.equal((await download(new URL(`${base}/ok`),32)).toString(),'ok');
    await assert.rejects(download(new URL(`${base}/large`),32),/size limit/);
    const started=Date.now(); await assert.rejects(download(new URL(`${base}/slow`),32,80),/timed out/); assert(Date.now()-started<2000,'body stalls remain within the full request deadline');
    const file=path.join(root,'download.bin');await fs.writeFile(file,Buffer.alloc(65));await assert.rejects(download(pathToFileURL(file),32),/size limit/);
    const link=path.join(root,'download-link');await fs.symlink(file,link);await assert.rejects(download(pathToFileURL(link),128));
    console.log('Store preparation streaming ZIP/download guards, exact captured bytes, issued-origin rebase, cleanup and full-body timeout PASS.');
  } finally {
    loader._load=original; for(const [name,value] of previous) {if(value===undefined)delete process.env[name];else process.env[name]=value;}
    for(const [index,name] of ['CANVAS_PLUGIN_STORE_REGISTRY_URL','CANVAS_SKILL_STORE_REGISTRY_URL'].entries()) {const value=previousRegistries[index];if(value===undefined)delete process.env[name];else process.env[name]=value;}
    await registry.close(); await sql.close(); await database.close();
    for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await fs.rm(root,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
