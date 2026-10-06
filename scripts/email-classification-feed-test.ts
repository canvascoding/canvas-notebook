import assert from 'node:assert/strict';
import Module from 'node:module';
import { NextRequest, NextResponse } from 'next/server';
import { PGlite } from '@electric-sql/pglite';
import { runEmailClassificationPostgresMigration } from '../app/lib/email/classification/postgres-migration';
import { runEmailClassificationFeedPostgresMigration } from '../app/lib/email/classification/feed-postgres-migration';
import { createEmailClassificationStore } from '../app/lib/email/classification/store';
import { readEmailClassificationFeed, emailFeedAuthorizedParameter, type EmailClassificationFeedDependencies } from '../app/lib/email/classification/feed-service';
import { readEmailClassificationMessage, setEmailClassificationPersonalFocus, updateEmailClassificationOverride, emailClassificationFeedErrorDetails } from '../app/lib/email/classification/state-service';
import { EMAIL_CLASSIFICATION_PROJECTED_SQL } from '../app/lib/email/classification/feed-sql';
import { emailClassificationFingerprint, emailClassificationMailboxRef } from '../app/lib/email/classification/identity';
import { matchesEmailMailboxScope, type AuthorizedEmailClassificationMailbox } from '../app/lib/email/classification/mailbox-types';
import { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION } from '../app/lib/email/classification/settings-types';
import { emailClassificationEvaluationFingerprint } from '../app/lib/email/classification/settings-evaluation';
import { EMAIL_CLASSIFICATION_SCHEMA_VERSION } from '../app/lib/email/classification/schema';
import { projectEmailClassification, emailFocusSortKey } from '../app/lib/email/classification/policy';
import type { EmailClassification, EmailClassificationRaw, EmailClassificationOverride } from '../app/lib/email/classification/types';
import type { EmailClassificationQueryable, EmailClassificationMetadataInput } from '../app/lib/email/classification/store-types';

async function main() {
  const postgres = new PGlite();
  try {
    await postgres.exec('CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES (\'owner\'),(\'member\'),(\'admin\');');
    await runEmailClassificationPostgresMigration(postgres);
    await runEmailClassificationFeedPostgresMigration(postgres);
    await runEmailClassificationFeedPostgresMigration(postgres);
    const store = createEmailClassificationStore({ postgres:postgres as unknown as EmailClassificationQueryable,
      transaction: operation=>postgres.transaction(connection=>operation(connection as unknown as EmailClassificationQueryable)) });
    let now = 10_000;
    const makeMailbox = (accountId:string,workspaceId:string|null):AuthorizedEmailClassificationMailbox => {
      const descriptor={ownerUserId:'owner',accountSource:workspaceId?'local' as const:'managed' as const,accountId,provider:'google',workspaceId,
        mailboxId:workspaceId?'binding-'+accountId:null,bindingRevision:'binding-'+accountId,policyRevision:'policy-'+accountId,
        active:true,readFrom:workspaceId?['@example.test']:[],emailAddress:accountId+'@example.test',displayName:accountId,workspaceName:workspaceId,
        capabilities:{canRead:true,canWrite:true,canDelete:true,canRunAgent:true,canManage:true}};
      return {...descriptor,mailboxRef:emailClassificationMailboxRef(descriptor)};
    };
    const personal = makeMailbox('personal',null); const work = makeMailbox('shared','workspace');
    let authorized = [personal,work];
    const dependencies:EmailClassificationFeedDependencies = {postgres:postgres as unknown as EmailClassificationQueryable,
      transaction:operation=>postgres.transaction(connection=>operation(connection as unknown as EmailClassificationQueryable)),store,now:()=>now,
      mailboxes:async(userId,scope={kind:'all'})=>authorized.filter(mailbox=>userId==='owner'||mailbox.workspaceId)
        .filter(mailbox=>matchesEmailMailboxScope(mailbox,scope)).map(mailbox=>({...mailbox,capabilities:{...mailbox.capabilities,canWrite:userId==='owner'}}))};
    for(const mailbox of authorized)await store.upsertMailbox(mailbox,now);
    const settings=await store.updateSettings({expectedRevision:0,actorUserId:'admin',configuration:{...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION,enabled:true,
      policy:{...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION.policy,spamSortingValidated:true,calibrationReference:'held-out-fixture',validatedProviderId:'typesafe',validatedModel:'jev-1.13.0',validatedSchemaVersion:EMAIL_CLASSIFICATION_SCHEMA_VERSION}},now});
    const hash=emailClassificationEvaluationFingerprint(settings.configuration);
    const baseRaw:EmailClassificationRaw={category:'support',categoryProbabilities:{support:0.9,other:0.1},categoryConfidence:0.9,
      priority:'normal',priorityProbabilities:{normal:0.9,low:0.1},priorityConfidence:0.9,spamProbability:0.1,replyProbability:0.1,
      providerId:'typesafe',model:'jev-1.13.0',adapterVersion:'fixture',schemaVersion:EMAIL_CLASSIFICATION_SCHEMA_VERSION,
      probabilitySemantics:'model_probability',calibrationReference:null,latencyMs:10,evaluatedAt:now,evaluatedBodyCharacters:100,bodyWasTruncated:false,usage:null};
    const fixtures:Array<{metadata:EmailClassificationMetadataInput;raw:EmailClassificationRaw|null;overrides:EmailClassificationOverride;state?:'pending'|'stale'|'failed';done:boolean}> = [];
    async function insert(id:string,mailbox:AuthorizedEmailClassificationMailbox,options:{raw?:Partial<EmailClassificationRaw>|null;overrides?:EmailClassificationOverride;state?:'pending'|'stale'|'failed';done?:boolean;from?:string;date?:number;inInbox?:boolean}={}) {
      const messageRef='emm:'+emailClassificationFingerprint([mailbox.mailboxRef,id]);
      const raw=options.raw===null?null:{...baseRaw,...options.raw};
      const metadata:EmailClassificationMetadataInput={messageRef,mailboxRef:mailbox.mailboxRef,canonicalId:id,folder:'INBOX',dateTimestamp:options.date??now,
        replyStatus:'unknown',fingerprint:'fingerprint-'+id,inInbox:options.inInbox??true,list:{from:options.from??'Customer <customer@example.test>',subject:id,date:'2026-10-06',snippet:'Short preview'}};
      await store.upsertMessageMetadata(metadata,now);
      if(raw||options.overrides)await postgres.query(`INSERT INTO email_classification_results(message_ref,raw_json,configuration_revision,evaluation_fingerprint,fingerprint,binding_revision,policy_revision,overrides_json,version,result_revision,updated_at)
        VALUES($1,$2::jsonb,$3,$4,$5,$6,$7,$8::jsonb,1,1,$9)`,[messageRef,raw?JSON.stringify(raw):null,raw?settings.revision:null,raw?(options.state==='stale'?'obsolete-evaluation':hash):null,
        raw?metadata.fingerprint:null,raw?mailbox.bindingRevision:null,raw?mailbox.policyRevision:null,JSON.stringify(options.overrides??{}),now]);
      if(options.state==='failed') {
        await store.enqueueClassification({messageRef,configurationRevision:settings.revision,fingerprint:metadata.fingerprint,now});
        await postgres.query("UPDATE email_classification_jobs SET status='failed',error_code='fixture' WHERE message_ref=$1",[messageRef]);
      }
      if(options.done)await store.setPersonalFocusState({userId:'owner',messageRef,expectedVersion:0,done:true,now});
      fixtures.push({metadata,raw,overrides:options.overrides??{},state:options.state,done:options.done??false});
      return messageRef;
    }
    for(let index=0;index<31;index++)await insert('chronological-'+index,personal,{date:now-index});
    const deepImportant=await insert('beyond-first-20',personal,{date:1,raw:{priority:'urgent',priorityProbabilities:{urgent:0.9,high:0.1}}});
    await insert('shared-important',work,{raw:{priority:'high',priorityProbabilities:{high:0.9,normal:0.1}}});
    await insert('reply',work,{raw:{replyProbability:0.75}});
    await insert('uncertain',work,{raw:{replyProbability:0.5}});
    await insert('spam',work,{raw:{spamProbability:0.95}});
    await insert('important-spam-conflict',work,{raw:{priority:'high',priorityProbabilities:{high:0.9,normal:0.1},spamProbability:0.95}});
    await insert('unqualified-spam',work,{raw:{spamProbability:0.99,probabilitySemantics:'score'}});
    await insert('unknown-choice',work,{raw:{priorityProbabilities:null,priorityConfidence:null}});
    await insert('margin-boundary',work,{raw:{priorityProbabilities:{normal:0.65,low:0.5}}});
    await insert('float-margin-boundary',work,{raw:{priorityProbabilities:{normal:0.7,low:0.55}}});
    const manual=await insert('manual-only',work,{raw:null,overrides:{category:'support',priority:'high',isSpam:false,needsReply:true}});
    const pending=await insert('pending',work,{raw:null});
    await insert('failed',work,{raw:null,state:'failed'});
    await insert('stale',work,{state:'stale'});
    await insert('stale-failed',work,{state:'failed',raw:{model:'old-model'}});
    await postgres.query('UPDATE email_classification_results SET evaluation_fingerprint=\'obsolete-evaluation\' WHERE message_ref=$1',[fixtures[fixtures.length-1].metadata.messageRef]);
    fixtures[fixtures.length-1].state='failed';
    await insert('done',work,{done:true});
    await insert('blocked-sender',work,{from:'attacker@evil.test',raw:{priority:'urgent',priorityProbabilities:{urgent:0.99,high:0.01}}});
    await insert('subdomain-blocked',work,{from:'attacker@sub.example.test'});
    await insert('sent-not-inbox',work,{inInbox:false});
    for(const mailbox of authorized)await store.recordMailboxSync({mailboxRef:mailbox.mailboxRef,bindingRevision:mailbox.bindingRevision,policyRevision:mailbox.policyRevision,cursor:null,coverage:'partial',now});

    // PostgreSQL projection is compared field-for-field to the application policy oracle.
    const oracle=await postgres.query<{message_ref:string;classification_json:EmailClassification}>(`${EMAIL_CLASSIFICATION_PROJECTED_SQL} SELECT message_ref,classification_json FROM projected`,
      ['owner',emailFeedAuthorizedParameter(authorized),JSON.stringify(settings.configuration.policy),hash,settings.revision,null,'']);
    const visible=fixtures.filter(fixture=>fixture.metadata.inInbox!==false && !['blocked-sender','subdomain-blocked'].includes(fixture.metadata.canonicalId));
    assert.equal(oracle.rows.length,visible.length);
    for(const row of oracle.rows) {
      const fixture=visible.find(candidate=>candidate.metadata.messageRef===row.message_ref)!;
      assert.deepEqual(row.classification_json,projectEmailClassification({raw:fixture.state==='stale'||fixture.state==='failed'?null:fixture.raw,
        overrides:fixture.overrides,policy:settings.configuration.policy,replyStatus:'unknown',personallyDone:fixture.done,version:fixture.raw||Object.keys(fixture.overrides).length?1:0,unavailableState:fixture.state}),fixture.metadata.canonicalId);
    }
    const expected=oracle.rows.sort((a,b)=>{
      const ak=emailFocusSortKey(a.classification_json),bk=emailFocusSortKey(b.classification_json);
      for(let index=0;index<3;index++)if(ak[index]!==bk[index])return ak[index]-bk[index];
      const ad=visible.find(candidate=>candidate.metadata.messageRef===a.message_ref)!.metadata.dateTimestamp!;
      const bd=visible.find(candidate=>candidate.metadata.messageRef===b.message_ref)!.metadata.dateTimestamp!;
      return bd-ad||a.message_ref.localeCompare(b.message_ref);
    }).map(row=>row.message_ref);
    const first=await readEmailClassificationFeed({userId:'owner',scope:{kind:'all'},mode:'focus',view:'all',limit:7},dependencies);
    assert.equal(first.items[0].messageRef,deepImportant,'An old urgent mail beyond the first provider page leads the global feed');
    assert.equal(first.counts.total,visible.length);assert.equal(first.coverage.length,2);assert.ok(first.coverage.every(source=>source.state==='partial'));
    assert.ok(first.items.some(item=>item.origin.workspaceId),'Shared and personal sources participate in the same ranking');
    assert.ok(first.items.every(item=>item.selectionKey.includes(item.origin.accountId)&&item.origin.accountOwnerId==='owner'));
    let page=first;const seen=first.items.map(item=>item.messageRef);
    while(page.nextCursor){page=await readEmailClassificationFeed({userId:'owner',scope:{kind:'all'},mode:'focus',view:'all',limit:7,cursor:page.nextCursor},dependencies);seen.push(...page.items.map(item=>item.messageRef));}
    assert.deepEqual(seen,expected,'Full SQL-ranked pagination has neither duplicates nor mailbox truncation');
    assert.equal(new Set(seen).size,expected.length);

    const focusDefault=await readEmailClassificationFeed({userId:'owner',scope:{kind:'all'},mode:'focus',limit:100},dependencies);
    assert.equal(focusDefault.view,'focus');
    assert.ok(focusDefault.items.every(item=>item.classification?.group==='important'||item.classification?.group==='reply'),'The focus start list contains only important mail and reply needs');
    assert.equal(focusDefault.items.length,focusDefault.counts.groups.important+focusDefault.counts.groups.reply);
    assert.ok(focusDefault.counts.groups.review>0 && focusDefault.counts.groups.pending>0,'Review and pending counts remain visible outside the start list');
    assert.equal(focusDefault.counts.total,visible.length);
    const reviewView=await readEmailClassificationFeed({userId:'owner',scope:{kind:'all'},view:'review',limit:100},dependencies);
    assert.ok(reviewView.items.length>0 && reviewView.items.every(item=>item.classification?.group==='review'));
    assert.equal(reviewView.items.length,reviewView.counts.groups.review);
    const pendingView=await readEmailClassificationFeed({userId:'owner',scope:{kind:'all'},view:'pending',limit:100},dependencies);
    assert.ok(pendingView.items.length>0 && pendingView.items.every(item=>item.classification?.group==='pending'));
    assert.equal(pendingView.items.length,pendingView.counts.groups.pending);
    assert.ok(pendingView.coverage.some(source=>source.failed>0 && source.pending>0),'Failed/pending coverage remains honest while the start list stays focused');

    const stable=await readEmailClassificationFeed({userId:'owner',scope:{kind:'all'},view:'all',limit:2},dependencies);
    const frozen=await postgres.query<{message_ref:string;classification_json:EmailClassification}>('SELECT message_ref,classification_json FROM email_classification_feed_rows WHERE snapshot_id=$1 ORDER BY ordinal',[stable.snapshot.id]);
    await postgres.query(`UPDATE email_classification_results SET raw_json=jsonb_set(raw_json,'{replyProbability}','0.9'::jsonb),version=version+1 WHERE raw_json IS NOT NULL`);
    const ratingsOnly=await readEmailClassificationFeed({userId:'owner',scope:{kind:'all'},view:'all',limit:2,cursor:stable.nextCursor!},dependencies);
    assert.equal(ratingsOnly.hasUpdates,true,'New ratings offer an explicit refresh without invalidating ongoing pages');
    await insert('new-mail-after-snapshot',personal,{date:now+100,raw:{priority:'urgent',priorityProbabilities:{urgent:0.9,high:0.1}}});
    const oldMetadata=await store.readMessages([pending]);
    await store.upsertMessageMetadata({...oldMetadata[0],list:{...oldMetadata[0].list,subject:'Changed preview after snapshot'}},now);
    const continued=await readEmailClassificationFeed({userId:'owner',scope:{kind:'all'},view:'all',limit:2,cursor:stable.nextCursor!},dependencies);
    assert.equal(continued.snapshot.id,stable.snapshot.id);assert.equal(continued.hasUpdates,true);
    assert.deepEqual(continued.items.map(item=>item.messageRef),frozen.rows.slice(2,4).map(row=>row.message_ref));
    assert.deepEqual(continued.items.map(item=>item.classification),frozen.rows.slice(2,4).map(row=>row.classification_json),'Asynchronous ratings updates do not reorder or replace a snapshot');
    const oldPage=await readEmailClassificationFeed({userId:'owner',scope:{kind:'all'},view:'all',limit:100,cursor:Buffer.from(JSON.stringify({v:1,id:stable.snapshot.id,after:0})).toString('base64url')},dependencies);
    assert.equal(oldPage.items.find(item=>item.messageRef===pending)?.message.subject,'pending','Snapshot list metadata does not drift between pages');
    const [archived]=await store.readMessages([deepImportant]);
    await store.upsertMessageMetadata({...archived,inInbox:false},now);
    const afterArchive=await readEmailClassificationFeed({userId:'owner',scope:{kind:'all'},view:'all',limit:100,cursor:Buffer.from(JSON.stringify({v:1,id:stable.snapshot.id,after:0})).toString('base64url')},dependencies);
    assert.ok(!afterArchive.items.some(item=>item.messageRef===deepImportant));assert.equal(afterArchive.counts.total,stable.counts.total-1,'Archived emails disappear from snapshot rows and counts without leaking old membership');
    await store.upsertMessageMetadata({...archived,inInbox:true},now);
    const searched=await readEmailClassificationFeed({userId:'owner',scope:{kind:'all'},view:'all',search:'beyond-first-20'},dependencies);
    assert.equal(searched.counts.total,1);assert.equal(searched.coverage.reduce((sum,source)=>sum+source.indexed,0),visible.length+1,'Source coverage counts the full authorized index, not just the search result');
    await assert.rejects(readEmailClassificationFeed({userId:'member',scope:{kind:'all'},view:'all',cursor:stable.nextCursor!},dependencies),/Refresh|changed/u);
    await assert.rejects(readEmailClassificationFeed({userId:'owner',scope:{kind:'work'},view:'all',cursor:stable.nextCursor!},dependencies),/Refresh|changed/u);
    authorized=[personal];
    await assert.rejects(readEmailClassificationFeed({userId:'owner',scope:{kind:'all'},view:'all',cursor:stable.nextCursor!},dependencies),/Refresh|changed/u);
    assert.equal((await readEmailClassificationFeed({userId:'owner',scope:{kind:'all'},view:'all'},dependencies)).coverage.length,1,'Revoked shared sources disappear before counts');
    await assert.rejects(readEmailClassificationMessage({userId:'owner',messageRef:manual},dependencies),/no longer available/u);
    authorized=[personal,work];
    await assert.rejects(updateEmailClassificationOverride({userId:'member',messageRef:manual,expectedVersion:1,overrides:{priority:'normal'}},dependencies),/permission/u);
    const done=await setEmailClassificationPersonalFocus({userId:'member',messageRef:manual,expectedVersion:0,done:true},dependencies);
    assert.equal(done.classification?.group,'done');assert.equal(done.personalFocus.version,1);
    assert.notEqual((await readEmailClassificationMessage({userId:'owner',messageRef:manual},dependencies)).classification?.group,'done','Personal completion cannot alter another reader or the team case');
    await assert.rejects(setEmailClassificationPersonalFocus({userId:'member',messageRef:manual,expectedVersion:0,done:false},dependencies),/changed/u);
    const undo=await setEmailClassificationPersonalFocus({userId:'member',messageRef:manual,expectedVersion:1,done:false},dependencies);assert.equal(undo.personalFocus.done,false);
    const corrected=await updateEmailClassificationOverride({userId:'owner',messageRef:manual,expectedVersion:1,overrides:{priority:'normal',isSpam:false,needsReply:false}},dependencies);
    assert.equal(corrected.classification?.overrides.isSpam,false);assert.equal(corrected.classification?.version,2);
    await assert.rejects(updateEmailClassificationOverride({userId:'owner',messageRef:manual,expectedVersion:1,overrides:{priority:'high'}},dependencies),/changed/u);
    const blocked=fixtures.find(fixture=>fixture.metadata.canonicalId==='blocked-sender')!.metadata.messageRef;
    await assert.rejects(setEmailClassificationPersonalFocus({userId:'owner',messageRef:blocked,expectedVersion:0,done:true},dependencies),/no longer available/u);
    const classic=await readEmailClassificationFeed({userId:'owner',scope:{kind:'all'},mode:'classic',limit:100},dependencies);
    assert.equal('canonicalId' in classic.items[0].message,false);
    assert.ok(classic.items.every(item=>item.classification===null));
    assert.equal(classic.items[0].message.subject,'new-mail-after-snapshot');
    const personalOnly=await readEmailClassificationFeed({userId:'owner',scope:{kind:'personal'},view:'all'},dependencies);
    assert.ok(personalOnly.items.every(item=>item.origin.accountScope==='personal'));
    const ownMailbox=await readEmailClassificationFeed({userId:'owner',scope:{kind:'mailbox',mailboxRef:work.mailboxRef},view:'all'},dependencies);
    assert.ok(ownMailbox.items.every(item=>item.origin.mailboxRef===work.mailboxRef));
    const snapshots=await postgres.query<{count:string}>('SELECT count(*)::text AS count FROM email_classification_feed_snapshots WHERE user_id=\'owner\'');assert.ok(Number(snapshots.rows[0].count)<=3);
    now+=10*60_000+1;
    await assert.rejects(readEmailClassificationFeed({userId:'owner',scope:{kind:'personal'},view:'all',cursor:personalOnly.nextCursor??Buffer.from(JSON.stringify({v:1,id:personalOnly.snapshot.id,after:0})).toString('base64url')},dependencies),/changed/u);
    const latestSettings=await store.readSettings();
    await store.updateSettings({expectedRevision:latestSettings.revision,actorUserId:'admin',configuration:{...latestSettings.configuration,enabled:false},now});
    const disabled=await readEmailClassificationFeed({userId:'owner',scope:{kind:'all'},mode:'focus',view:'important'},dependencies);
    assert.equal(disabled.mode,'classic');assert.equal(disabled.view,'all');assert.ok(disabled.items.every(item=>item.classification===null));
    assert.equal(Object.values(disabled.counts.groups).reduce((sum,count)=>sum+count,0),0);
    assert.equal((await readEmailClassificationMessage({userId:'owner',messageRef:manual},dependencies)).assessment,null);
    await routeTests(deepImportant);
    await postgres.query('DELETE FROM "user" WHERE id=\'owner\'');
    assert.equal((await postgres.query('SELECT id FROM email_classification_feed_snapshots')).rows.length,0,'Owner removal cascades snapshots and message references');
    console.log('Email classification feed SQL, snapshots, authorization and personal state tests passed.');
  } finally { await postgres.close(); }
}

async function routeTests(messageRef:string) {
  type Load=(request:string,parent:NodeModule|null,isMain:boolean)=>unknown;
  const loader=Module as typeof Module & {_load:Load};const original=loader._load;
  let signedIn=true;let limited=false;let failure:Error|null=null;
  const calls:Array<Record<string,unknown>>=[];const rates:Array<{verifiedUserId?:string}>=[];
  const match=(request:string,name:string)=>request===`@/app/lib/${name}`||request.endsWith(`/app/lib/${name}`)||request.endsWith(`/app/lib/${name}.ts`);
  const handle=async(input:Record<string,unknown>)=>{calls.push(input);if(failure)throw failure;return {messageRef};};
  loader._load=(request,parent,isMain)=>{
    if(match(request,'auth'))return {auth:{api:{getSession:async()=>signedIn?{user:{id:'verified-reader'}}:null}}};
    if(match(request,'security/trusted-origins')||request==='./trusted-origins'&&parent?.filename.includes('/app/lib/security/'))return {isConfiguredTrustedOrigin:(origin:string)=>origin==='https://canvas.test'};
    if(match(request,'utils/rate-limit'))return {rateLimit:(_request:NextRequest,options:{verifiedUserId?:string})=>{rates.push(options);return limited?{ok:false,response:NextResponse.json({success:false,error:'Limited'},{status:429})}:{ok:true};}};
    if(match(request,'email/classification/feed-service'))return {readEmailClassificationFeed:handle};
    if(match(request,'email/classification/state-service'))return {readEmailClassificationMessage:handle,updateEmailClassificationOverride:handle,setEmailClassificationPersonalFocus:handle,emailClassificationFeedErrorDetails};
    return original(request,parent,isMain);
  };
  try {
    const feed=await import('../app/api/email/classification/feed/route');const detail=await import('../app/api/email/classification/message/route');
    const override=await import('../app/api/email/classification/override/route');const focus=await import('../app/api/email/classification/focus/route');
    const request=(path:string,method='GET',payload?:unknown,headers:Record<string,string>={})=>new NextRequest('https://canvas.test'+path,{method,
      headers:{'Content-Type':'application/json',...(method==='GET'?{}:{Origin:'https://canvas.test','Sec-Fetch-Site':'same-origin'}),...headers},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
    const check=(response:Response,status:number)=>{assert.equal(response.status,status);assert.equal(response.headers.get('Cache-Control'),'private, no-store');};
    const validOverride={messageRef,expectedVersion:3,overrides:{priority:'high'}};const validFocus={messageRef,expectedVersion:0,done:true};
    signedIn=false;
    check(await feed.GET(request('/api/email/classification/feed')),401);check(await detail.GET(request('/api/email/classification/message?messageRef='+messageRef)),401);
    check(await override.PATCH(request('/api/email/classification/override','PATCH',validOverride)),401);check(await focus.PATCH(request('/api/email/classification/focus','PATCH',validFocus)),401);
    assert.equal(calls.length,0);
    signedIn=true;
    check(await override.PATCH(request('/api/email/classification/override','PATCH',validOverride,{Origin:'https://attacker.test'})),403);
    check(await focus.PATCH(request('/api/email/classification/focus','PATCH',validFocus,{'Sec-Fetch-Site':'cross-site'})),403);
    assert.equal(calls.length,0,'Cross-origin sessions never reach state services');
    check(await focus.PATCH(request('/api/email/classification/focus','PATCH',{...validFocus,userId:'victim'})),400);
    check(await override.PATCH(request('/api/email/classification/override','PATCH',{...validOverride,accountOwnerId:'victim'})),400);
    check(await feed.GET(request('/api/email/classification/feed?accountId=forged')),400);
    check(await feed.GET(request('/api/email/classification/feed?scope=all&scope=work')),400);
    check(await detail.GET(request('/api/email/classification/message')),400);
    check(await detail.GET(request('/api/email/classification/message?messageRef='+messageRef+'&accountId=forged')),400);
    assert.equal(calls.length,0);
    check(await feed.GET(request('/api/email/classification/feed?scope=work&mode=focus&view=reply&limit=7')),200);
    assert.equal(calls[0].userId,'verified-reader');assert.deepEqual(calls[0].scope,{kind:'work'});
    check(await detail.GET(request('/api/email/classification/message?messageRef='+messageRef)),200);
    check(await override.PATCH(request('/api/email/classification/override','PATCH',validOverride)),200);
    check(await focus.PATCH(request('/api/email/classification/focus','PATCH',validFocus)),200);
    assert.ok(calls.every(call=>call.userId==='verified-reader'));assert.ok(rates.every(rate=>rate.verifiedUserId==='verified-reader'));
    limited=true;const count=calls.length;check(await feed.GET(request('/api/email/classification/feed')),429);assert.equal(calls.length,count);limited=false;
    failure=new Error('Provider secret KEY=private and endpoint https://private.test');
    const unsafe=await detail.GET(request('/api/email/classification/message?messageRef='+messageRef));check(unsafe,503);
    assert.equal((await unsafe.text()).includes('private.test'),false);
  }finally{loader._load=original;}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
