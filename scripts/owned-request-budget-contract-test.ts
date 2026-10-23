import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOwnedRequestBudgetCoordinator, ownedRequestBudgetEnabled } from '../tests/helpers/owned-request-budget';
import { waitForFileCreateBudget } from '../tests/helpers/create-request-budget';
import { privateBytes, type OwnedYjsReceipt } from './lib/owned-yjs-authority-qa';

async function main(): Promise<void> {
  const environment = { ...process.env };
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'owned-request-budget-contract-')));
  let passed = 0;
  try {
    await fs.chmod(root, 0o700); await fs.mkdir(path.join(root, 'data'), { mode: 0o700 });
    const rootStat = await fs.stat(root), dataStat = await fs.stat(path.join(root, 'data'));
    const nonce = crypto.randomBytes(16).toString('hex'), ownerMarker = crypto.randomBytes(24).toString('hex');
    const receipt: OwnedYjsReceipt = {
      version:1,nonce,fixtureRoot:root,repo:process.cwd(),head:'0'.repeat(40),buildId:'private-budget-contract',
      sourceFingerprint:'0'.repeat(64),buildFingerprint:'0'.repeat(64),ownerMarker,
      rootDevice:String(rootStat.dev),rootInode:String(rootStat.ino),dataRoot:path.join(root,'data'),
      dataDevice:String(dataStat.dev),dataInode:String(dataStat.ino),databaseName:`canvas_yjs_e2e_${nonce}`,
      databaseOid:null,databaseOwner:null,createAcknowledged:false,phase:'browser',actorId:crypto.randomUUID(),uncertain:false,
      parentPid:process.pid,parentStart:'private file contract only',serverPid:null,serverStart:null,issuerPid:null,
      issuerDatabaseOid:null,issuerDatabaseOwner:null,issuerDatabaseMarker:null,restartCount:0,port:42187,
      databaseDropped:false,dataRemoved:false,controlPlaneRoot:root,controlPlaneHead:'0'.repeat(40),passed:false,
      selectedSpecs:[],completedSpecs:[],activeSpec:null,failurePhase:null,
    };
    const receiptPath = path.join(root,'recovery.json');
    await fs.writeFile(path.join(root,'.fixture-owner'),ownerMarker,{mode:0o600,flag:'wx'});
    await fs.writeFile(receiptPath,JSON.stringify(receipt),{mode:0o600,flag:'wx'});
    Object.assign(process.env,{CANVAS_YJS_AUTHORITY_E2E:'1',E2E_EXTERNAL_SERVER:'1',CANVAS_YJS_QA_RECEIPT:receiptPath,
      CANVAS_YJS_QA_NONCE:nonce,BASE_URL:'http://127.0.0.1:42187'});
    let now = Date.now(); const waits: number[] = [];
    const clock = { now:() => now,wait:async (milliseconds:number) => {
      assert(Number.isSafeInteger(milliseconds) && milliseconds > 0); waits.push(milliseconds); now += milliseconds;
    } };
    const check = async (name:string,operation:() => Promise<void>) => { await operation(); passed++; console.log(`Owned request budget passed: ${name}`); };
    const read = async (kind:string) => JSON.parse((await privateBytes(path.join(root,`request-budget-${kind}.json`))).toString()) as {
      requests:number[];notBefore:number;observedAt:number;nonce:string;
    };
    const first = createOwnedRequestBudgetCoordinator(clock), nextWorker = createOwnedRequestBudgetCoordinator(clock);
    await check('nineteen simultaneous reservations serialize into one actual private create ledger',async () => {
      await Promise.all(Array.from({length:19},() => first.wait('files-create')));
      assert.equal(waits.length,0); assert.equal((await read('files-create')).requests.length,19);
      assert.equal((await fs.stat(path.join(root,'request-budget-files-create.json'))).mode & 0o777,0o600);
    });
    await check('a fresh coordinator reads the previous worker ledger and waits the real configured window',async () => {
      const started = now;
      await nextWorker.wait('files-create'); assert.equal(now-started,61_000);
      assert.deepEqual(waits,[61_000]); assert.deepEqual((await read('files-create')).requests,[now]);
    });
    await check('an unknown tree bucket waits a full window without inventing an issued request',async () => {
      const started = now; await nextWorker.quiet('files-tree');
      assert.equal(now-started,61_000); assert.deepEqual((await read('files-tree')).requests,[]);
    });
    await check('browser and direct-API reservations share the same durable tree limit',async () => {
      const started = now;
      for (let index=0; index<59; index++) await nextWorker.wait('files-tree');
      assert.equal(now,started); assert.equal((await read('files-tree')).requests.length,59);
      await createOwnedRequestBudgetCoordinator(clock).wait('files-tree');
      assert.equal(now-started,61_000); assert.deepEqual((await read('files-tree')).requests,[now]);
    });
    await check('each following case waits until its latest known tree request fully expires before UI work',async () => {
      now += 123; await nextWorker.wait('files-tree'); const last = now;
      now += 10; await first.quiet('files-tree');
      assert.equal(now,last+61_000); assert.deepEqual((await read('files-tree')).requests,[]);
    });
    await check('clock rollback and ledger nonce tampering reject instead of resetting the budget',async () => {
      await first.wait('files-create'); const saved = await privateBytes(path.join(root,'request-budget-files-create.json'));
      now--; await assert.rejects(nextWorker.wait('files-create')); now++;
      await fs.writeFile(path.join(root,'request-budget-files-create.json'),JSON.stringify({...JSON.parse(saved.toString()),nonce:'f'.repeat(32)}));
      await assert.rejects(nextWorker.wait('files-create'));
      await fs.writeFile(path.join(root,'request-budget-files-create.json'),saved);
      assert((await privateBytes(path.join(root,'request-budget-files-create.json'))).equals(saved));
    });
    await check('private permissions, uncertain shutdown and missing owned flags fail closed',async () => {
      const filename = path.join(root,'request-budget-files-create.json'), before = await privateBytes(filename);
      await fs.chmod(filename,0o644); await assert.rejects(first.wait('files-create')); await fs.chmod(filename,0o600);
      await fs.writeFile(receiptPath,JSON.stringify({...receipt,uncertain:true})); await assert.rejects(first.wait('files-create'));
      await fs.writeFile(receiptPath,JSON.stringify(receipt));
      delete process.env.CANVAS_YJS_AUTHORITY_E2E;
      assert.throws(ownedRequestBudgetEnabled); await assert.rejects(first.wait('files-create'));
      process.env.CANVAS_YJS_AUTHORITY_E2E='1'; delete process.env.E2E_EXTERNAL_SERVER;
      assert.throws(ownedRequestBudgetEnabled); await assert.rejects(first.wait('files-create'));
      process.env.E2E_EXTERNAL_SERVER='1';
      assert((await privateBytes(filename)).equals(before));
    });
    await check('ordinary create calls retain their existing in-memory branch and never touch the owned ledger',async () => {
      const before = await privateBytes(path.join(root,'request-budget-files-create.json'));
      delete process.env.CANVAS_YJS_AUTHORITY_E2E; delete process.env.CANVAS_YJS_QA_RECEIPT;
      assert.equal(ownedRequestBudgetEnabled(),false);
      await waitForFileCreateBudget(); await waitForFileCreateBudget();
      assert((await privateBytes(path.join(root,'request-budget-files-create.json'))).equals(before));
    });
    assert.equal(passed,8);
  } finally {
    await fs.rm(root,{recursive:true,force:true});
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env,environment);
  }
  console.log(`owned-request-budget-contract-test: ${passed} private filesystem/virtual-clock contracts passed after cleanup; no application or database was started.`);
}

void main().catch(error => { console.error(error); process.exitCode=1; });
