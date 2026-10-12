import assert from 'node:assert/strict';
import {
  buildEmailClassificationQuestions, buildEmailDecisionState, DEFAULT_EMAIL_QUESTION_PROFILE,
  EMAIL_CLASSIFICATION_MAX_BODY_CHARACTERS, EMAIL_CLASSIFICATION_SCHEMA_VERSION, validateEmailQuestionProfile,
} from '../app/lib/email/classification/schema';
import { emailFocusSortKey, projectEmailClassification, validateEmailClassificationOverride, validateEmailClassificationPolicy } from '../app/lib/email/classification/policy';
import { DEFAULT_EMAIL_CLASSIFICATION_POLICY, type EmailClassificationRaw } from '../app/lib/email/classification/types';
import { normalizeEmailClassificationResult } from '../app/lib/email/classification/normalize';

const raw: EmailClassificationRaw = {
  category: 'support', categoryProbabilities: { support: 0.91, correspondence: 0.09 }, categoryConfidence: 0.88,
  priority: 'high', priorityProbabilities: { high: 0.9, normal: 0.1 }, priorityConfidence: 0.84,
  spamProbability: 0.02, replyProbability: 0.93,
  providerId: 'typesafe', model: 'fixture-model', adapterVersion: 'fixture', schemaVersion: EMAIL_CLASSIFICATION_SCHEMA_VERSION,
  probabilitySemantics: 'model_probability', calibrationReference: null, latencyMs: 100, evaluatedAt: 1,
  evaluatedBodyCharacters: 100, bodyWasTruncated: false, usage: { inputTokens: 30, outputTokens: 10 },
};
const questions = buildEmailClassificationQuestions();
assert.deepEqual(Object.keys(questions), ['category', 'priority', 'is_spam', 'needs_reply']);
assert.equal(questions.category.type, 'choice'); assert.equal(questions.priority.type, 'choice');
assert.equal(questions.is_spam.type, 'binary'); assert.equal(questions.needs_reply.type, 'binary');
assert.match(questions.priority.instructions, /Promotional urgency/);
assert.match(questions.is_spam.instructions, /subscribed newsletter/);
assert.match(questions.needs_reply.instructions, /already replied/);
for (const question of Object.values(questions)) assert.match(question.instructions, /untrusted data/);

const message = { from: 'customer@example.test', to: ['support@example.test'], subject: 'Order delayed', body: 'Please investigate', mailboxScope: 'workspace' as const };
const work = buildEmailDecisionState(message);
assert.equal(work.state.email.body, message.body);
assert.equal(work.state.mailboxContext, DEFAULT_EMAIL_QUESTION_PROFILE.workPurpose);
assert.equal(buildEmailDecisionState({ ...message, mailboxScope: 'personal' }).state.mailboxContext, DEFAULT_EMAIL_QUESTION_PROFILE.personalPurpose);
const truncated = buildEmailDecisionState({ ...message, body: 'a'.repeat(EMAIL_CLASSIFICATION_MAX_BODY_CHARACTERS + 1) });
assert.equal(truncated.bodyWasTruncated, true); assert.equal(truncated.evaluatedBodyCharacters, EMAIL_CLASSIFICATION_MAX_BODY_CHARACTERS);
assert.equal(buildEmailDecisionState({ ...message, body: '\0bad\ntext' }).state.email.body, 'bad\ntext');
assert.equal('attachments' in work.state.email, false);
assert.deepEqual(validateEmailQuestionProfile(DEFAULT_EMAIL_QUESTION_PROFILE), DEFAULT_EMAIL_QUESTION_PROFILE);
assert.throws(() => validateEmailQuestionProfile({ ...DEFAULT_EMAIL_QUESTION_PROFILE, categoryCriteria: { injected: 'evil' } }));

const important = projectEmailClassification({ raw });
assert.equal(important.group, 'important'); assert.equal(important.needsReply, true); assert.equal(important.replyStatus, 'unknown');
assert.equal(important.spamProbability, 0.02); assert.equal(important.replyProbability, 0.93);
assert.equal(projectEmailClassification({ raw, personallyDone: true }).group, 'done', 'Personal completion affects every focus group');
assert.equal(projectEmailClassification({ raw, replyStatus: 'answered' }).group, 'important', 'Answering does not resolve important information');
const normal = { ...raw, priority: 'normal' as const, priorityProbabilities: { normal: 0.94, low: 0.06 } };
assert.equal(projectEmailClassification({ raw: normal }).group, 'reply');
assert.equal(projectEmailClassification({ raw: normal, replyStatus: 'answered' }).group, 'other');
assert.equal(projectEmailClassification({ raw: { ...normal, replyProbability: 0.1 } }).group, 'other');
assert.equal(projectEmailClassification({ raw: { ...raw, replyProbability: 0.02 } }).group, 'important', 'Security-like importance does not need a reply');
assert.equal(projectEmailClassification({ raw: null }).group, 'pending');
assert.equal(projectEmailClassification({ raw: null }).spamProbability, null, 'Missing is not zero');
assert.equal(projectEmailClassification({ raw, unavailableState: 'stale' }).group, 'pending');
assert.equal(projectEmailClassification({ raw: null, unavailableState: 'failed' }).status, 'failed');
assert.equal(projectEmailClassification({ raw: { ...raw, priorityProbabilities: null } }).group, 'review', 'No invented choice confidence');
assert.equal(projectEmailClassification({ raw: { ...raw, priorityProbabilities: { high: 0.52, normal: 0.48 } } }).group, 'review');
assert.equal(projectEmailClassification({ raw: { ...normal, replyProbability: 0.5 } }).group, 'review');
assert.equal(projectEmailClassification({ raw: { ...normal, spamProbability: 0.99 } }).group, 'review', 'Unvalidated spam remains reachable');
const validated = { ...DEFAULT_EMAIL_CLASSIFICATION_POLICY, spamSortingValidated: true, calibrationReference: 'fixture-evaluation-v1', validatedProviderId: raw.providerId, validatedModel: raw.model, validatedSchemaVersion: raw.schemaVersion };
assert.equal(projectEmailClassification({ raw: { ...normal, spamProbability: 0.99 }, policy: validated }).group, 'spam');
assert.equal(projectEmailClassification({ raw: { ...normal, model: 'different-model', spamProbability: 0.99 }, policy: validated }).group, 'review', 'Validation is bound to actual model');
assert.equal(projectEmailClassification({ raw: { ...normal, probabilitySemantics: 'uncalibrated_score', spamProbability: 0.99 }, policy: validated }).group, 'review', 'Uncalibrated scores cannot hide mail');
assert.equal(projectEmailClassification({ raw: { ...raw, spamProbability: 0.99 }, policy: validated }).group, 'review', 'Important/spam conflict wins');
const override = projectEmailClassification({ raw: { ...normal, spamProbability: 0.99 }, overrides: { isSpam: false, priority: 'urgent' }, version: 3 });
assert.equal(override.group, 'important'); assert.equal(override.spamProbability, 0.99, 'Manual correction does not fabricate 0%');
assert.equal(override.version, 3);
assert.equal(projectEmailClassification({ raw: normal, overrides: { needsReply: false } }).group, 'other');
assert.equal(projectEmailClassification({ raw: { ...raw, categoryProbabilities: { support: 0.51, correspondence: 0.49 } } }).group, 'important', 'Uncertain category alone does not block urgency');
assert.deepEqual(validateEmailClassificationOverride({ category: 'security', isSpam: false }), { category: 'security', isSpam: false });
assert.throws(() => validateEmailClassificationOverride({ isSpam: 'false' }));
assert.throws(() => validateEmailClassificationOverride({ workspaceId: 'other' }));
assert.throws(() => validateEmailClassificationOverride({ category: 'made-up' }));
assert.deepEqual(validateEmailClassificationPolicy(DEFAULT_EMAIL_CLASSIFICATION_POLICY), DEFAULT_EMAIL_CLASSIFICATION_POLICY);
assert.throws(() => validateEmailClassificationPolicy({ ...validated, calibrationReference: null }));
assert.throws(() => validateEmailClassificationPolicy({ ...validated, replyPositiveThreshold: 0.2 }));
assert.throws(() => validateEmailClassificationPolicy({ ...validated, spamNegativeThreshold: NaN }));
assert(emailFocusSortKey(important)[0] < emailFocusSortKey(projectEmailClassification({ raw: normal }))[0]);
assert(emailFocusSortKey(projectEmailClassification({ raw: { ...raw, priority: 'urgent', priorityProbabilities: { urgent: 0.98, high: 0.02 } } }))[1] < emailFocusSortKey(important)[1]);
const providerResult = {
  answers: { category: { type: 'choice' as const, choice: 'support' }, priority: { type: 'choice' as const, choice: 'high' }, is_spam: { type: 'binary' as const, probability: 0.02 }, needs_reply: { type: 'binary' as const, probability: 0.93 } },
  model: 'fixture', providerId: 'systemone', latencyMs: 12, adapterVersion: 'fixture', probabilitySemantics: 'relative_probability' as const,
};
const normalized = normalizeEmailClassificationResult(providerResult, { evaluatedBodyCharacters: 42, bodyWasTruncated: true, evaluatedAt: 1 });
assert.equal(normalized.categoryProbabilities, null); assert.equal(normalized.categoryConfidence, null);
assert.equal(normalized.spamProbability, 0.02); assert.equal(normalized.bodyWasTruncated, true);
assert.equal(normalized.calibrationReference, null); assert.equal(normalized.schemaVersion, EMAIL_CLASSIFICATION_SCHEMA_VERSION);
assert.throws(() => normalizeEmailClassificationResult({ ...providerResult, answers: { ...providerResult.answers, category: { type: 'choice', choice: 'injected' } } }, { evaluatedBodyCharacters: 0, bodyWasTruncated: false }));
console.log('Email classification schema/policy passed: four questions, bounded data, conservative grouping, status/probability separation, corrections and personal completion.');
