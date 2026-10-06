import 'server-only';
import { isEmailAddressAllowed } from '@/app/lib/email/policy';
import { emailOriginSelectionKey } from './mailbox-types';
import { emailFeedMessageOrigin, runtimeEmailClassificationFeedDependencies, type EmailClassificationFeedDependencies } from './feed-service';
import { EmailClassificationFeedError, type EmailClassificationFeedItem } from './feed-types';
import { isStoredEmailClassificationResultCurrent } from './index-service';
import { projectEmailClassification, validateEmailClassificationOverride } from './policy';
import { EmailClassificationStoreStateError, EmailClassificationVersionConflictError } from './store-types';
import type { EmailClassificationOverride, EmailClassificationRaw } from './types';

type StateDependencies = Pick<EmailClassificationFeedDependencies,'store'|'mailboxes'|'now'>;
export interface EmailClassificationMessageDetail extends EmailClassificationFeedItem {
  assessment: Pick<EmailClassificationRaw,'categoryProbabilities'|'categoryConfidence'|'priorityProbabilities'|'priorityConfidence'|'probabilitySemantics'> | null;
}
async function authorizedMessage(userId: string, messageRef: string, dependencies: StateDependencies, write = false) {
  if (!/^emm:[a-f0-9]{64}$/u.test(messageRef)) throw new EmailClassificationFeedError('INVALID_EMAIL_REFERENCE',400,'Invalid email reference.');
  const mailboxes=await dependencies.mailboxes(userId,{kind:'all'});
  const [metadata]=await dependencies.store.readMessages([messageRef]);
  const mailbox=metadata && mailboxes.find(source=>source.mailboxRef===metadata.mailboxRef
    && source.bindingRevision===metadata.mailbox.bindingRevision && source.policyRevision===metadata.mailbox.policyRevision);
  if (!metadata || !mailbox || !mailbox.capabilities.canRead || mailbox.workspaceId && !isEmailAddressAllowed(metadata.list.from,mailbox.readFrom)) {
    throw new EmailClassificationFeedError('EMAIL_MESSAGE_UNAVAILABLE',404,'The email is no longer available.');
  }
  if (write && mailbox.workspaceId && !mailbox.capabilities.canWrite) throw new EmailClassificationFeedError('EMAIL_CORRECTION_FORBIDDEN',403,'You do not have permission to correct this mailbox.');
  return {metadata,mailbox};
}
function version(value: number) { if (!Number.isSafeInteger(value) || value<0) throw new EmailClassificationFeedError('INVALID_EMAIL_VERSION',400,'Provide the current email state version.'); }

export async function readEmailClassificationMessage(input: {userId:string;messageRef:string}, dependencies?: StateDependencies): Promise<EmailClassificationMessageDetail> {
  const deps=dependencies ?? await runtimeEmailClassificationFeedDependencies();
  const {metadata,mailbox}=await authorizedMessage(input.userId,input.messageRef,deps);
  const [settings,results,focusStates]=await Promise.all([deps.store.readSettings(),deps.store.readResultsBatch([input.messageRef]),deps.store.readPersonalFocusStates(input.userId,[input.messageRef])]);
  const result=results[0]; const focus=focusStates[0];
  const current=isStoredEmailClassificationResultCurrent(result,metadata,settings.configuration);
  const jobs=settings.revision ? await deps.store.readClassificationJobStates([input.messageRef],settings.revision):new Map();
  const raw=current?result!.raw:null;
  const state=current?undefined:jobs.get(input.messageRef)==='failed'?'failed':result?.raw?'stale':'pending';
  const origin=emailFeedMessageOrigin(mailbox,{canonical_id:metadata.canonicalId,folder:metadata.folder});
  return {messageRef:input.messageRef,selectionKey:emailOriginSelectionKey(origin),origin,message:metadata.list,
    classification:settings.configuration.enabled?projectEmailClassification({raw,overrides:result?.overrides,policy:settings.configuration.policy,
      replyStatus:metadata.replyStatus,personallyDone:focus?.done,version:result?.version,unavailableState:state}):null,
    personalFocus:{done:focus?.done ?? false,version:focus?.version ?? 0},
    assessment:settings.configuration.enabled && raw ? {categoryProbabilities:raw.categoryProbabilities,categoryConfidence:raw.categoryConfidence,
      priorityProbabilities:raw.priorityProbabilities,priorityConfidence:raw.priorityConfidence,probabilitySemantics:raw.probabilitySemantics}:null};
}

export async function updateEmailClassificationOverride(input: {userId:string;messageRef:string;expectedVersion:number;overrides:EmailClassificationOverride}, dependencies?: StateDependencies): Promise<EmailClassificationMessageDetail> {
  version(input.expectedVersion);
  let overrides:EmailClassificationOverride;
  try { overrides=validateEmailClassificationOverride(input.overrides); } catch { throw new EmailClassificationFeedError('INVALID_EMAIL_CORRECTION',400,'Invalid email correction.'); }
  const deps=dependencies ?? await runtimeEmailClassificationFeedDependencies();
  const {mailbox}=await authorizedMessage(input.userId,input.messageRef,deps,true);
  await deps.store.updateOverride({messageRef:input.messageRef,expectedVersion:input.expectedVersion,overrides,now:deps.now(),
    expectedBindingRevision:mailbox.bindingRevision,expectedPolicyRevision:mailbox.policyRevision});
  return readEmailClassificationMessage(input,deps);
}

/** Read access is sufficient: this row belongs only to the verified actor. */
export async function setEmailClassificationPersonalFocus(input: {userId:string;messageRef:string;expectedVersion:number;done:boolean}, dependencies?: StateDependencies): Promise<EmailClassificationMessageDetail> {
  version(input.expectedVersion);
  if (typeof input.done !== 'boolean') throw new EmailClassificationFeedError('INVALID_EMAIL_FOCUS_STATE',400,'Invalid personal completion state.');
  const deps=dependencies ?? await runtimeEmailClassificationFeedDependencies();
  const {mailbox}=await authorizedMessage(input.userId,input.messageRef,deps);
  await deps.store.setPersonalFocusState({...input,now:deps.now(),expectedBindingRevision:mailbox.bindingRevision,expectedPolicyRevision:mailbox.policyRevision});
  return readEmailClassificationMessage(input,deps);
}

export function emailClassificationFeedErrorDetails(error: unknown): {code:string;status:number;message:string} {
  if (error instanceof EmailClassificationFeedError) return {code:error.code,status:error.status,message:error.message};
  if (error instanceof EmailClassificationVersionConflictError) return {code:error.code,status:409,message:'The email state changed. Refresh before saving.'};
  if (error instanceof EmailClassificationStoreStateError) return {code:'EMAIL_MESSAGE_UNAVAILABLE',status:404,message:'The email is no longer available.'};
  return {code:'EMAIL_FEED_UNAVAILABLE',status:503,message:'The email view is temporarily unavailable.'};
}
