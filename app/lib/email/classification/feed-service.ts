import 'server-only';
import { randomUUID } from 'node:crypto';
import { emailClassificationFingerprint } from './identity';
import { emailOriginSelectionKey, type AuthorizedEmailClassificationMailbox, type EmailMessageOrigin } from './mailbox-types';
import type { resolveAuthorizedEmailClassificationMailboxes } from './mailbox-registry';
import { getRuntimeEmailClassificationStore, type PostgresEmailClassificationStore } from './store';
import type { EmailClassificationQueryable, EmailClassificationTransaction, EmailIndexedMessageList } from './store-types';
import { emailClassificationEvaluationFingerprint } from './settings-evaluation';
import { EMAIL_CATEGORY_IDS, type EmailClassification, type EmailFocusGroup } from './types';
import { EmailClassificationFeedError, type EmailClassificationFeed, type EmailClassificationFeedInput, type EmailClassificationFeedItem, type EmailClassificationFeedCoverage } from './feed-types';
import { EMAIL_CLASSIFICATION_PROJECTED_SQL, EMAIL_CLASSIFICATION_AUTHORIZED_SQL, EMAIL_CLASSIFICATION_SENDER_SQL } from './feed-sql';

export interface EmailClassificationFeedDependencies {
  postgres: EmailClassificationQueryable; transaction: EmailClassificationTransaction; store: PostgresEmailClassificationStore;
  mailboxes: typeof resolveAuthorizedEmailClassificationMailboxes; now: () => number;
}
const TTL = 10 * 60_000;
const groups: EmailFocusGroup[] = ['important','reply','review','pending','other','spam','done'];
const snapshotCandidatesSQL = `WITH ${EMAIL_CLASSIFICATION_AUTHORIZED_SQL}, visible_snapshot AS (
  SELECT s.* FROM email_classification_feed_rows s JOIN candidates c ON c.message_ref=s.message_ref AND c.mailbox_ref=s.mailbox_ref
  CROSS JOIN LATERAL (SELECT lower(btrim(coalesce(substring(s.list_json->>'from' FROM '<([^>]+)>'),s.list_json->>'from',''))) AS address) frozen_sender
  WHERE s.snapshot_id=$3 AND ${EMAIL_CLASSIFICATION_SENDER_SQL.replaceAll('a.', 'c.').replaceAll('sender.', 'frozen_sender.')}
)`;
export async function runtimeEmailClassificationFeedDependencies(): Promise<EmailClassificationFeedDependencies> {
  const database = await import('@/app/lib/db');
  database.assertDatabaseAvailable();
  const postgres = database.getPostgresRuntimeQueryable();
  if (!postgres) throw new Error('Email index is unavailable.');
  const transaction: EmailClassificationTransaction = async operation => {
    const connection = await postgres.connect();
    let discard: Error | undefined;
    try { await connection.query('BEGIN'); const result = await operation(connection); await connection.query('COMMIT'); return result; }
    catch (error) { try { await connection.query('ROLLBACK'); } catch { discard = new Error('Email feed transaction failed.'); } throw error; }
    finally { connection.release(discard); }
  };
  const registry = await import('./mailbox-registry');
  return { postgres, transaction, store: await getRuntimeEmailClassificationStore(), mailboxes: registry.resolveAuthorizedEmailClassificationMailboxes, now: Date.now };
}

export function emailFeedAuthorizedParameter(mailboxes: AuthorizedEmailClassificationMailbox[]): string {
  return JSON.stringify(mailboxes.map(mailbox => ({ mailbox_ref: mailbox.mailboxRef, binding_revision: mailbox.bindingRevision,
    policy_revision: mailbox.policyRevision, workspace_id: mailbox.workspaceId, read_from: mailbox.readFrom })));
}
export function emailFeedMessageOrigin(mailbox: AuthorizedEmailClassificationMailbox, row: { canonical_id: string; folder: string }): EmailMessageOrigin {
  return { mailboxRef: mailbox.mailboxRef, accountSource: mailbox.accountSource, accountId: mailbox.accountId,
    accountScope: mailbox.workspaceId ? 'workspace' : 'personal', accountOwnerId: mailbox.ownerUserId,
    mailboxId: mailbox.mailboxId, workspaceId: mailbox.workspaceId, workspaceName: mailbox.workspaceName,
    emailAddress: mailbox.emailAddress, displayName: mailbox.displayName, folder: row.folder, canonicalId: row.canonical_id,
    capabilities: { ...mailbox.capabilities } };
}
function resetCursor(): never { throw new EmailClassificationFeedError('EMAIL_FEED_CURSOR_INVALID', 409, 'The mailbox view changed. Refresh the list.'); }
function parseCursor(value: string): { id: string; after: number } {
  try {
    if (value.length > 400) return resetCursor();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed.v !== 1 || typeof parsed.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(parsed.id) || !Number.isSafeInteger(parsed.after) || parsed.after < 0) return resetCursor();
    return { id: parsed.id, after: parsed.after };
  } catch { return resetCursor(); }
}
function validateInput(input: EmailClassificationFeedInput) {
  if (!input.userId || !['all','personal','work','mailbox'].includes(input.scope.kind)
    || input.scope.kind === 'mailbox' && !/^emb:[a-f0-9]{64}$/u.test(input.scope.mailboxRef)) throw new EmailClassificationFeedError('INVALID_EMAIL_FEED',400,'Invalid mailbox scope.');
  const mode = input.mode ?? 'focus'; const view = input.view ?? (mode === 'focus' ? 'focus' : 'all');
  if (!['focus','classic'].includes(mode) || !['focus','all',...groups].includes(view)
    || input.category && !(EMAIL_CATEGORY_IDS as readonly string[]).includes(input.category)
    || input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 300)
    || input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw new EmailClassificationFeedError('INVALID_EMAIL_FEED',400,'Invalid email filters.');
  return { mode, view, search: input.search?.trim().toLowerCase() ?? '', limit: input.limit ?? 50 };
}
async function indexSignature(connection: EmailClassificationQueryable, mailboxes: AuthorizedEmailClassificationMailbox[], userId:string): Promise<string> {
  const { rows } = await connection.query(`WITH ${EMAIL_CLASSIFICATION_AUTHORIZED_SQL}, totals AS (
    SELECT mailbox_ref,count(*) AS message_count,sum(index_revision) AS message_versions,sum(coalesce(version,0)) AS result_versions,
      sum(focus_version) AS focus_versions FROM candidates GROUP BY mailbox_ref
  ) SELECT b.mailbox_ref,b.binding_revision,b.policy_revision,b.active,b.coverage,b.last_sync_at,
    t.message_count,t.message_versions,t.result_versions,t.focus_versions FROM authorized a
    LEFT JOIN email_classification_mailboxes b ON b.mailbox_ref=a.mailbox_ref LEFT JOIN totals t ON t.mailbox_ref=a.mailbox_ref ORDER BY a.mailbox_ref`,
  [userId,emailFeedAuthorizedParameter(mailboxes)]);
  return emailClassificationFingerprint(rows);
}
interface SnapshotRow extends Record<string, unknown> {
  id: string; selector_hash: string; authorization_signature: string; index_signature: string; settings_revision: string | number;
  expires_at: string | number; counts_json: EmailClassificationFeed['counts']; coverage_json: EmailClassificationFeedCoverage[];
}
interface PageRow extends Record<string, unknown> {
  ordinal: string | number; message_ref: string; mailbox_ref: string; canonical_id: string; folder: string;
  list_json: EmailIndexedMessageList; classification_json: EmailClassification; focus_version: string | number;
}

/** All ranking, filtering and counts execute in PostgreSQL over the complete authorized index. */
export async function readEmailClassificationFeed(input: EmailClassificationFeedInput, dependencies?: EmailClassificationFeedDependencies): Promise<EmailClassificationFeed> {
  const validated = validateInput(input); const deps = dependencies ?? await runtimeEmailClassificationFeedDependencies();
  const mailboxes = await deps.mailboxes(input.userId, input.scope);
  if (input.scope.kind === 'mailbox' && !mailboxes.length) throw new EmailClassificationFeedError('EMAIL_MAILBOX_UNAVAILABLE',404,'The mailbox is no longer available.');
  // Discovery has no model side effects and remains available when classification is disabled.
  for (const mailbox of mailboxes) await deps.store.upsertMailbox(mailbox);
  const settings = await deps.store.readSettings(); const now = deps.now();
  const mode = settings.configuration.enabled ? validated.mode : 'classic';
  const view = mode === 'classic' ? 'all' : validated.view;
  const category=settings.configuration.enabled?input.category??null:null;
  const selectorHash = emailClassificationFingerprint([input.scope,mode,view,category,validated.search]);
  const authorizationSignature = emailClassificationFingerprint(mailboxes.map(mailbox => [mailbox.mailboxRef, mailbox.bindingRevision,
    mailbox.policyRevision, mailbox.readFrom, mailbox.capabilities]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
  const authorization = emailFeedAuthorizedParameter(mailboxes); const cursor = input.cursor ? parseCursor(input.cursor) : null;
  return deps.transaction(async connection => {
    await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`email-feed:${input.userId}`]);
    await connection.query('DELETE FROM email_classification_feed_snapshots WHERE expires_at <= $1', [now]);
    const signature = await indexSignature(connection,mailboxes,input.userId);
    const currentSettings = await connection.query<{revision: string | number}>('SELECT revision FROM email_classification_settings WHERE id=\'instance\'');
    if (Number(currentSettings.rows[0]?.revision ?? 0) !== settings.revision) return resetCursor();
    let snapshot: SnapshotRow;
    if (cursor) {
      const result = await connection.query<SnapshotRow>('SELECT * FROM email_classification_feed_snapshots WHERE id=$1 AND user_id=$2 AND expires_at>$3',[cursor.id,input.userId,now]);
      snapshot = result.rows[0];
      if (!snapshot || snapshot.selector_hash !== selectorHash || snapshot.authorization_signature !== authorizationSignature
        || Number(snapshot.settings_revision) !== settings.revision) return resetCursor();
    } else {
      const id = randomUUID();
      await connection.query(`INSERT INTO email_classification_feed_snapshots(id,user_id,selector_hash,authorization_signature,index_signature,settings_revision,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,input.userId,selectorHash,authorizationSignature,signature,settings.revision,now,now+TTL]);
      await connection.query(`${EMAIL_CLASSIFICATION_PROJECTED_SQL}
        INSERT INTO email_classification_feed_rows(snapshot_id,ordinal,message_ref,mailbox_ref,canonical_id,folder,list_json,classification_json,focus_version)
        SELECT $9, row_number() OVER (ORDER BY
          CASE WHEN $8='focus' THEN group_rank ELSE 0 END,
          CASE WHEN $8='focus' THEN priority_rank ELSE 0 END,
          CASE WHEN $8='focus' THEN reply_rank ELSE 0 END,
          date_timestamp DESC NULLS LAST, message_ref ASC), message_ref,mailbox_ref,canonical_id,folder,list_json,classification_json,focus_version FROM projected`,
      [input.userId,authorization,JSON.stringify(settings.configuration.policy),emailClassificationEvaluationFingerprint(settings.configuration),settings.revision,category,validated.search,mode,id]);
      snapshot=(await connection.query<SnapshotRow>('SELECT * FROM email_classification_feed_snapshots WHERE id=$1',[id])).rows[0];
      await connection.query(`DELETE FROM email_classification_feed_snapshots WHERE user_id=$1 AND id<>$2 AND id IN (
        SELECT id FROM email_classification_feed_snapshots WHERE user_id=$1 AND id<>$2 ORDER BY created_at DESC,id DESC OFFSET 2)`,[input.userId,id]);
    }
    const page=await connection.query<PageRow>(`${snapshotCandidatesSQL}
      SELECT s.* FROM visible_snapshot s
      WHERE s.ordinal>$4 AND ($5='all' OR $5='focus' AND s.classification_json->>'group' IN ('important','reply','review','pending') OR s.classification_json->>'group'=$5)
      ORDER BY s.ordinal LIMIT $6`,[input.userId,authorization,snapshot.id,cursor?.after ?? 0,view,validated.limit+1]);
    const groupCounts=await connection.query<{group:EmailFocusGroup;category:string|null;count:string}>(`${snapshotCandidatesSQL}
      SELECT classification_json->>'group' AS "group",classification_json->>'category' AS category,count(*)::text AS count FROM visible_snapshot GROUP BY 1,2`,[input.userId,authorization,snapshot.id]);
    const counts:EmailClassificationFeed['counts']={total:0,groups:Object.fromEntries(groups.map(group=>[group,0])) as Record<EmailFocusGroup,number>,categories:{}};
    for (const row of groupCounts.rows) {
      counts.total+=Number(row.count);
      if (settings.configuration.enabled) { counts.groups[row.group]+=Number(row.count); if (row.category) counts.categories[row.category as keyof typeof counts.categories]=(counts.categories[row.category as keyof typeof counts.categories] ?? 0)+Number(row.count); }
    }
    const coverageRows=await connection.query<{mailbox_ref:string;indexed:string;pending:string;failed:string;stale:string}>(`${EMAIL_CLASSIFICATION_PROJECTED_SQL}
      SELECT mailbox_ref,count(*)::text AS indexed,count(*) FILTER(WHERE decision_status='pending')::text AS pending,
      count(*) FILTER(WHERE decision_status='failed')::text AS failed,count(*) FILTER(WHERE decision_status='stale')::text AS stale FROM grouped GROUP BY mailbox_ref`,
    [input.userId,authorization,JSON.stringify(settings.configuration.policy),emailClassificationEvaluationFingerprint(settings.configuration),settings.revision,category,validated.search]);
    const sourceRows=await connection.query<{mailbox_ref:string;coverage:EmailClassificationFeedCoverage['state'];last_sync_at:string|null}>(`SELECT mailbox_ref,coverage,last_sync_at FROM email_classification_mailboxes WHERE mailbox_ref=ANY($1::text[])`,[mailboxes.map(mailbox=>mailbox.mailboxRef)]);
    const coverage=mailboxes.map(mailbox=> {
      const source=sourceRows.rows.find(row=>row.mailbox_ref===mailbox.mailboxRef); const count=coverageRows.rows.find(row=>row.mailbox_ref===mailbox.mailboxRef);
      return {mailboxRef:mailbox.mailboxRef,state:source?.coverage ?? 'pending',lastSyncAt:source?.last_sync_at == null?null:Number(source.last_sync_at),indexed:Number(count?.indexed ?? 0),
        pending:settings.configuration.enabled?Number(count?.pending ?? 0):0,failed:settings.configuration.enabled?Number(count?.failed ?? 0):0,stale:settings.configuration.enabled?Number(count?.stale ?? 0):0};
    });
    const rows=page.rows.slice(0,validated.limit);
    const items: EmailClassificationFeedItem[]=rows.map(row=> {
      const mailbox=mailboxes.find(candidate=>candidate.mailboxRef===row.mailbox_ref)!; const origin=emailFeedMessageOrigin(mailbox,row);
      return {messageRef:row.message_ref,selectionKey:emailOriginSelectionKey(origin),origin,message:row.list_json,
        classification:mode==='focus'?row.classification_json:null,
        personalFocus:{done:row.classification_json.personallyDone,version:Number(row.focus_version)}};
    });
    const nextCursor=page.rows.length>validated.limit?Buffer.from(JSON.stringify({v:1,id:snapshot.id,after:Number(rows[rows.length-1].ordinal)})).toString('base64url'):null;
    await connection.query('UPDATE email_classification_feed_snapshots SET counts_json=$2::jsonb,coverage_json=$3::jsonb WHERE id=$1',[snapshot.id,JSON.stringify(counts),JSON.stringify(coverage)]);
    return {scope:input.scope,requestedMode:validated.mode,mode,view,items,nextCursor,snapshot:{id:snapshot.id,expiresAt:Number(snapshot.expires_at)},
      counts,coverage,hasUpdates:await indexSignature(connection,mailboxes,input.userId)!==snapshot.index_signature,
      limits:{initialLookbackDays:settings.configuration.initialLookbackDays,maxHistoricalMessages:settings.configuration.maxHistoricalMessages}};
  });
}
