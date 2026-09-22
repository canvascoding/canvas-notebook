import assert from 'node:assert/strict';
import { parseEmailSearchQuery, normalizeEmailSearchQuery, matchesEmailSearch, compileImapEmailSearch, compileGmailEmailSearch, compileMicrosoftEmailSearch, EmailSearchQueryError } from '../app/lib/email/search-query';

const messages = [
  { from: 'Anna <anna@example.test>', to: 'Bob <bob@example.test>', cc: 'Finance <finance@example.test>', bcc: 'audit@example.test', subject: 'Rechnung für Projekt Alpha', body: `${'older content '.repeat(10000)}September Überweisung` },
  { from: 'info@example.test', to: 'Anna <anna@example.test>', subject: 'Angebot Oktober', body: 'Projekt Beta' },
  { from: 'other@example.test', subject: 'Rechnung', body: 'Oktober' },
];
const cases: Array<[string, number[]]> = [
  ['rechnung september', [0]], ['rechnung AND september', [0]], ['rechnung OR angebot', [0, 1, 2]],
  ['angebot OR rechnung AND september', [0, 1]], ['(angebot OR rechnung) AND september', [0]],
  ['to:anna@example.test', [1]], ['cc:finance', [0]], ['bcc:audit@example.test', [0]],
  ['from:anna@example.test AND subject:rechnung', [0]], ['body:Überweisung', [0]],
  ['subject:"Projekt Alpha"', [0]], ['body:"Projekt Alpha"', []], ['"Projekt Beta"', [1]],
  ['body:september', [0]], ['body:"überweisung"', [0]], ['body:"AND OR"', []],
];
for (const [query, expected] of cases) {
  const expression = parseEmailSearchQuery(query);
  assert.deepEqual(messages.flatMap((message, index) => matchesEmailSearch(expression, message) ? [index] : []), expected, query);
  assert.deepEqual(parseEmailSearchQuery(normalizeEmailSearchQuery(query)), expression);
}
for (const query of ['OR alpha', 'alpha AND', 'alpha OR )', '()', '(alpha', 'alpha)', '"open', 'unknown:term', 'from:', 'subject:()', '""', 'alpha\n beta', 'a'.repeat(1025), '('.repeat(9) + 'a' + ')'.repeat(9), Array(65).fill('a').join(' ')]) {
  assert.throws(() => parseEmailSearchQuery(query), EmailSearchQueryError, query);
}
for (const invalid of [5, {}, [], true]) assert.throws(() => parseEmailSearchQuery(invalid as unknown as string), EmailSearchQueryError);
assert.equal(parseEmailSearchQuery('  '), null);
assert.deepEqual(parseEmailSearchQuery('and'), { type: 'term', value: 'and' });
assert.equal(compileGmailEmailSearch(parseEmailSearchQuery('body:"deep text" OR to:anna')), '("deep text" OR to:"anna")');
const microsoft = compileMicrosoftEmailSearch(parseEmailSearchQuery('alpha beta'));
for (const field of ['from', 'to', 'cc', 'bcc', 'subject', 'body']) assert.ok(microsoft.includes(`${field}:"alpha"`));
assert.ok(microsoft.includes(' AND '));
// Execute the generated IMAP Boolean form independently, including repeated fields.
function matchImap(search: Record<string, unknown>, message: typeof messages[number]): boolean {
  return Object.entries(search).every(([field, value]) => {
    if (field === 'all') return true;
    if (field === 'not') return !matchImap(value as Record<string, unknown>, message);
    if (field === 'or') return (value as Array<Record<string, unknown>>).some((part) => matchImap(part, message));
    return String(message[field as keyof typeof message] || '').toLocaleLowerCase().includes(String(value).toLocaleLowerCase());
  });
}
for (const [query, expected] of cases.filter(([query]) => !query.includes('ü'))) {
  const compiled = compileImapEmailSearch(parseEmailSearchQuery(query));
  assert.deepEqual(messages.flatMap((message, index) => matchImap(compiled as Record<string, unknown>, message) ? [index] : []), expected, query);
}
console.log('Email search grammar, cross-field matching, deep body, Unicode and provider Boolean contracts passed.');
