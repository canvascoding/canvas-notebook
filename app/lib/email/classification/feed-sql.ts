import { emailClassificationSelectionSql } from './selection';

/** Mirrors projectEmailClassification. The PostgreSQL oracle tests exercise both implementations. */
export const EMAIL_CLASSIFICATION_SENDER_SQL = `(
  a.workspace_id IS NULL OR jsonb_array_length(a.read_from) = 0 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(a.read_from) allowed(address)
    WHERE CASE WHEN left(allowed.address, 2) = '*@' THEN substring(allowed.address FROM 3) = split_part(sender.address, '@', 2)
      WHEN left(allowed.address, 1) = '@' THEN substring(allowed.address FROM 2) = split_part(sender.address, '@', 2)
      ELSE allowed.address = sender.address END
  )
)`;

export const EMAIL_CLASSIFICATION_AUTHORIZED_SQL = `
  authorized AS (
    SELECT * FROM jsonb_to_recordset($2::jsonb) AS a(mailbox_ref text, binding_revision text, policy_revision text, workspace_id text, read_from jsonb)
  ), candidates AS (
    SELECT m.*, r.raw_json AS stored_raw, r.overrides_json, r.version,
      r.evaluation_fingerprint, r.fingerprint AS result_fingerprint,
      r.binding_revision AS result_binding, r.policy_revision AS result_policy,
      coalesce(p.done, false) AS personally_done, coalesce(p.version, 0) AS focus_version,
      a.binding_revision, a.policy_revision, a.workspace_id, a.read_from
    FROM authorized a
    JOIN email_classification_mailboxes b ON b.mailbox_ref=a.mailbox_ref AND b.active
      AND b.binding_revision=a.binding_revision AND b.policy_revision=a.policy_revision
    JOIN email_classification_messages m ON m.mailbox_ref=b.mailbox_ref
    CROSS JOIN LATERAL (SELECT lower(btrim(coalesce(substring(m.list_json->>'from' FROM '<([^>]+)>'), m.list_json->>'from', ''))) AS address) sender
    LEFT JOIN email_classification_results r ON r.message_ref=m.message_ref
    LEFT JOIN email_classification_personal_focus p ON p.message_ref=m.message_ref AND p.user_id=$1
    WHERE m.in_inbox AND ${EMAIL_CLASSIFICATION_SENDER_SQL}
  )`;

export const EMAIL_CLASSIFICATION_PROJECTED_SQL = `
  WITH ${EMAIL_CLASSIFICATION_AUTHORIZED_SQL},
  latest_jobs AS (
    SELECT DISTINCT ON (j.message_ref) j.message_ref, j.status FROM email_classification_jobs j
    JOIN candidates c ON c.message_ref=j.message_ref
    WHERE j.configuration_revision=$5 AND j.fingerprint=c.fingerprint
      AND j.binding_revision=c.binding_revision AND j.policy_revision=c.policy_revision
    ORDER BY j.message_ref, j.updated_at DESC, j.id DESC
  ), raw_state AS (
    SELECT c.*, coalesce(c.overrides_json, '{}'::jsonb) AS overrides,
      CASE WHEN c.stored_raw IS NOT NULL AND c.evaluation_fingerprint=$4 AND c.result_fingerprint=c.fingerprint
        AND c.result_binding=c.binding_revision AND c.result_policy=c.policy_revision THEN c.stored_raw END AS raw,
      CASE WHEN NOT coalesce(${emailClassificationSelectionSql('c', '$8', '$9')},false) THEN 'not_selected'
        WHEN j.status='failed' THEN 'failed' WHEN c.stored_raw IS NOT NULL AND NOT coalesce(c.evaluation_fingerprint=$4 AND c.result_fingerprint=c.fingerprint
        AND c.result_binding=c.binding_revision AND c.result_policy=c.policy_revision,false) THEN 'stale'
        ELSE 'pending' END AS missing
    FROM candidates c LEFT JOIN latest_jobs j ON j.message_ref=c.message_ref
  ), decisions AS (
    SELECT r.*,
      coalesce(overrides->>'category',raw->>'category') AS category,
      coalesce(overrides->>'priority',raw->>'priority') AS priority,
      CASE WHEN raw IS NULL THEN NULL WHEN (raw->>'spamProbability')::double precision >= ($3::jsonb->>'spamPositiveThreshold')::double precision THEN true
        WHEN (raw->>'spamProbability')::double precision <= ($3::jsonb->>'spamNegativeThreshold')::double precision THEN false END AS raw_spam,
      CASE WHEN raw IS NULL THEN NULL WHEN (raw->>'replyProbability')::double precision >= ($3::jsonb->>'replyPositiveThreshold')::double precision THEN true
        WHEN (raw->>'replyProbability')::double precision <= ($3::jsonb->>'replyNegativeThreshold')::double precision THEN false END AS raw_reply,
      coalesce(($3::jsonb->>'spamSortingValidated')::boolean AND nullif($3::jsonb->>'calibrationReference','') IS NOT NULL
        AND $3::jsonb->>'validatedProviderId'=raw->>'providerId' AND $3::jsonb->>'validatedModel'=raw->>'model'
        AND $3::jsonb->>'validatedSchemaVersion'=raw->>'schemaVersion'
        AND raw->>'probabilitySemantics' IN ('model_probability','relative_probability'),false) AS validated_spam,
      CASE WHEN overrides ? 'category' THEN 'ready' WHEN raw IS NULL THEN missing
        WHEN jsonb_typeof(raw->'categoryProbabilities'->(raw->>'category'))='number'
          AND (raw->'categoryProbabilities'->>(raw->>'category'))::double precision >= ($3::jsonb->>'choiceMinimumProbability')::double precision
          AND (raw->'categoryProbabilities'->>(raw->>'category'))::double precision - coalesce((
            SELECT max(value::double precision) FROM jsonb_each_text(CASE WHEN jsonb_typeof(raw->'categoryProbabilities')='object' THEN raw->'categoryProbabilities' ELSE '{}'::jsonb END)
              WHERE key <> raw->>'category'),0) >= ($3::jsonb->>'choiceMinimumMargin')::double precision THEN 'ready' ELSE 'uncertain' END AS category_state,
      CASE WHEN overrides ? 'priority' THEN 'ready' WHEN raw IS NULL THEN missing
        WHEN jsonb_typeof(raw->'priorityProbabilities'->(raw->>'priority'))='number'
          AND (raw->'priorityProbabilities'->>(raw->>'priority'))::double precision >= ($3::jsonb->>'choiceMinimumProbability')::double precision
          AND (raw->'priorityProbabilities'->>(raw->>'priority'))::double precision - coalesce((
            SELECT max(value::double precision) FROM jsonb_each_text(CASE WHEN jsonb_typeof(raw->'priorityProbabilities')='object' THEN raw->'priorityProbabilities' ELSE '{}'::jsonb END)
              WHERE key <> raw->>'priority'),0) >= ($3::jsonb->>'choiceMinimumMargin')::double precision THEN 'ready' ELSE 'uncertain' END AS priority_state
    FROM raw_state r
  ), effective AS (
    SELECT d.*,
      CASE WHEN overrides ? 'isSpam' THEN (overrides->>'isSpam')::boolean WHEN raw_spam=true AND NOT validated_spam THEN NULL ELSE raw_spam END AS is_spam,
      CASE WHEN overrides ? 'needsReply' THEN (overrides->>'needsReply')::boolean ELSE raw_reply END AS needs_reply,
      CASE WHEN overrides ? 'isSpam' THEN 'ready' WHEN raw IS NULL THEN missing WHEN raw_spam IS NULL OR raw_spam=true AND NOT validated_spam THEN 'uncertain' ELSE 'ready' END AS spam_state,
      CASE WHEN overrides ? 'needsReply' THEN 'ready' WHEN raw IS NULL THEN missing WHEN raw_reply IS NULL THEN 'uncertain' ELSE 'ready' END AS reply_state
    FROM decisions d
  ), grouped AS (
    SELECT e.*,
      CASE WHEN personally_done THEN 'done'
        WHEN NOT (priority_state IN ('ready','uncertain') OR spam_state IN ('ready','uncertain') OR reply_state IN ('ready','uncertain')) THEN CASE WHEN missing='not_selected' THEN 'other' ELSE 'pending' END
        WHEN priority IN ('high','urgent') AND is_spam=true THEN 'review'
        WHEN 'uncertain' IN (priority_state,spam_state,reply_state) THEN 'review'
        WHEN is_spam=true THEN 'spam'
        WHEN priority IN ('high','urgent') AND priority_state='ready' THEN 'important'
        WHEN needs_reply=true AND reply_status <> 'answered' THEN 'reply'
        WHEN priority_state <> 'ready' OR spam_state <> 'ready' OR reply_state <> 'ready' THEN CASE WHEN missing='not_selected' THEN 'other' ELSE 'pending' END
        ELSE 'other' END AS focus_group,
      CASE WHEN category_state='ready' AND priority_state='ready' AND spam_state='ready' AND reply_state='ready' THEN 'ready'
        WHEN 'uncertain' IN (category_state,priority_state,spam_state,reply_state) THEN 'uncertain' ELSE missing END AS decision_status
    FROM effective e
  ), projected AS (
    SELECT g.*, jsonb_build_object('category',category,'priority',priority,
      'spamProbability',raw->'spamProbability','replyProbability',raw->'replyProbability','isSpam',is_spam,'needsReply',needs_reply,
      'states',jsonb_build_object('category',category_state,'priority',priority_state,'spam',spam_state,'reply',reply_state),
      'status',decision_status,'replyStatus',reply_status,'group',focus_group,'overrides',overrides,
      'personallyDone',personally_done,'version',coalesce(version,0),'evaluatedAt',raw->'evaluatedAt',
      'bodyWasTruncated',coalesce((raw->>'bodyWasTruncated')::boolean,false)) AS classification_json,
      CASE focus_group WHEN 'important' THEN 0 WHEN 'reply' THEN 1 WHEN 'review' THEN 2 WHEN 'pending' THEN 3 WHEN 'other' THEN 4 WHEN 'spam' THEN 5 ELSE 6 END AS group_rank,
      CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 WHEN 'low' THEN 4 ELSE 5 END AS priority_rank,
      CASE WHEN needs_reply=true THEN 0 ELSE 1 END AS reply_rank
    FROM grouped g
    WHERE ($6::text IS NULL OR category=$6) AND ($7::text='' OR position($7::text IN lower(coalesce(list_json->>'subject','') || ' ' || coalesce(list_json->>'from','') || ' ' || coalesce(list_json->>'snippet',''))) > 0)
  )`;
