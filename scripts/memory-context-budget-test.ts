import assert from 'node:assert/strict';

import { buildBudgetedMemoryBlock } from '../app/lib/memory/prompt-budget';
import { formatMemoryToolRead, formatMemoryToolWrite } from '../app/lib/memory/tool-response';
import type { MemoryEntry, MemoryReadResult } from '../app/lib/memory/service';

const candidates = [
  { id: 'pinned', content: 'A'.repeat(60), scopeType: 'user' as const },
  { id: 'oversized', content: 'B'.repeat(800), scopeType: 'agent' as const },
  { id: 'shared', content: 'A shared fact.', scopeType: 'workspace' as const },
];

const { block, selectedIds } = buildBudgetedMemoryBlock(candidates, 75);
assert.ok(Math.ceil(block.length / 4) <= 75, 'headings and framing must count toward the budget');
assert.deepEqual(selectedIds, ['pinned', 'shared'], 'an oversized entry must not hide a later fitting entry');
assert.match(block, /### User Memory/);
assert.match(block, /### Workspace Memory/);
assert.doesNotMatch(block, /### Agent Memory/);
assert.deepEqual(buildBudgetedMemoryBlock(candidates, 1), { block: '', selectedIds: [] });

const entries: MemoryEntry[] = Array.from({ length: 40 }, (_, index) => ({
  id: `entry-${index}`,
  content: `Fact ${index}`,
  status: 'published',
  priority: 50,
  pinned: false,
  collectionId: 'collection',
  updatedAt: 1,
}));
const inventory: MemoryReadResult = { target: 'user', entries };
const read = formatMemoryToolRead(inventory);
assert.equal(read.entries.length, 20);
assert.equal(read.omittedCount, 20);
assert.equal(read.nextOffset, 20);
assert.match(read.text, /20 more entries/);
assert.doesNotMatch(read.text, /entry-39/);
assert.ok(read.text.length < 6_200);
const secondPage = formatMemoryToolRead(inventory, read.nextOffset!);
assert.equal(secondPage.entries[0]?.id, 'entry-20');
assert.equal(secondPage.nextOffset, null);
assert.equal(secondPage.omittedCount, 0);

const write = formatMemoryToolWrite({ changed: true, entry: entries[0], entries });
assert.match(write, /entry-0/);
assert.doesNotMatch(write, /entry-1/);
assert.match(write, /Active entries in this scope: 40/);

console.log('memory-context-budget-test: ok');
