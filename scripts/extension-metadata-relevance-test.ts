import assert from 'node:assert/strict';
import { scoreExtensionMetadata } from '../app/lib/capabilities/extensions/relevance';

const description = (value: string) => ({ name: 'zzzz', title: 'yyyy', description: value });
const installed = {
  name: 'approval-guide-owned', title: 'Approval Guide Owned',
  description: 'Interne Messefreigabekriterien für Messekampagnen, Bildrechte und Budgetfreigabe. Internal trade fair campaign approval checklist and escalation.',
};
const actualQuery = 'Messekampagne Freigabekriterien Eskalation Marketing';

assert(scoreExtensionMetadata(installed, actualQuery) > 0,
  'The actual failed model query must find the installed German compound/plural metadata.');
assert.equal(scoreExtensionMetadata(installed, 'Messekampagne'), 1);
assert.equal(scoreExtensionMetadata(installed, 'Freigabekriterien'), 1);
assert.equal(scoreExtensionMetadata(installed, 'MESSEKAMPAGNE / FREIGABEKRITERIEN'), 2);
assert.equal(scoreExtensionMetadata(installed, 'Messekampange'), 0, 'Containment does not guess a misspelled word.');
assert.equal(scoreExtensionMetadata(installed, 'Freigabekriterine'), 0);
assert.equal(scoreExtensionMetadata(installed, 'Kochrezepte Steuerbescheide'), 0);

assert.equal(scoreExtensionMetadata(description('approval workflow'), 'approvals workflows'), 2,
  'A longer query word can contain the exact installed word.');
assert.equal(scoreExtensionMetadata(description('campaigns approvals'), 'campaign approval'), 2,
  'An installed plural can contain the query word.');
assert.equal(scoreExtensionMetadata(description('Validations financières'), 'validation financiere'), 2);
assert.equal(scoreExtensionMetadata(description('Überprüfungen'), 'UBERPRUFUNG'), 1,
  'Existing Unicode normalization remains shared by exact and partial matching.');
assert.equal(scoreExtensionMetadata(description('承認基準'), '承認基準'), 2, 'Exact non-Latin tokens retain their existing score.');

assert.equal(scoreExtensionMetadata(description('campaign approval'), 'a'), 0);
assert.equal(scoreExtensionMetadata(description('campaign approval'), 'ap'), 0);
assert.equal(scoreExtensionMetadata(description('campaign approval'), 'cam'), 0);
assert.equal(scoreExtensionMetadata(description('campaign approval'), 'camp'), 1, 'Partial matching starts at four characters.');
assert.equal(scoreExtensionMetadata(description('API UX'), 'api'), 2, 'Short exact metadata tokens remain searchable.');
assert.equal(scoreExtensionMetadata(description('API UX'), 'apis'), 0,
  'A partial match requires four characters on both sides.');
assert.equal(scoreExtensionMetadata(description('campaign'), 'campaign campaign'), 2, 'Repeated query words never multiply relevance.');
assert.equal(scoreExtensionMetadata(description('campaigns'), 'campaign campaign'), 1);
assert.equal(scoreExtensionMetadata(description('anything'), ' \t '), 0);

const query = 'campaign approval';
const ranked = [
  { name: 'exact', entry: { name: 'campaign approval', title: 'Exact', description: '' }, score: 1_000 },
  { name: 'prefix', entry: { name: 'campaign approval helper', title: 'Prefix', description: '' }, score: 800 },
  { name: 'substring', entry: { name: 'retail campaign approval helper', title: 'Substring', description: '' }, score: 600 },
  { name: 'exact title token', entry: { name: 'zzzz', title: 'Campaign', description: '' }, score: 20 },
  { name: 'partial title token', entry: { name: 'zzzz', title: 'Campaigns', description: '' }, score: 10 },
  { name: 'exact description token', entry: description('campaign'), score: 2 },
  { name: 'partial description token', entry: description('campaigns'), score: 1 },
  { name: 'unrelated', entry: description('invoices'), score: 0 },
];
for (const candidate of ranked) assert.equal(scoreExtensionMetadata(candidate.entry, query), candidate.score, candidate.name);
assert.deepEqual([...ranked].reverse().sort((left, right) => scoreExtensionMetadata(right.entry, query)
  - scoreExtensionMetadata(left.entry, query)).map(candidate => candidate.name), ranked.map(candidate => candidate.name));
assert.deepEqual(ranked.map(candidate => scoreExtensionMetadata(candidate.entry, query)),
  ranked.map(candidate => scoreExtensionMetadata(candidate.entry, query)), 'Repeated ranking remains deterministic.');

const first32 = Array.from({ length: 32 }, (_, index) => `unrelated${index}`).join(' ');
assert.equal(scoreExtensionMetadata(description('campaign'), `${first32} campaign`), 0, 'Query token matching keeps its existing 32-token bound.');
assert.equal(scoreExtensionMetadata(description(`${first32} campaign`), 'campaign'), 0, 'Description token matching remains bounded.');
assert.equal(scoreExtensionMetadata(description('campaign'), `campaign ${first32}`), 2);

console.log('PASS extension metadata relevance: actual German query, bounded compounds/plurals, Unicode, short-token and typo nonmatches, exact/title priority and deterministic scores.');
