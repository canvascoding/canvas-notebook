import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { applyAgentTextTargets, createAgentTextTarget } from '../app/lib/collaboration/agent-operations';

function operation(doc: Y.Doc, targets: ReturnType<typeof createAgentTextTarget>[], independentGroups = false) {
  return applyAgentTextTargets({
    doc,
    targets,
    independentGroups,
    origin: { actorType: 'agent', actorId: 'agent-b', initiatedByUserId: 'user-b', operationId: randomUUID() },
  });
}

const doc = new Y.Doc({ gc: true });
const text = doc.getText('content');
text.insert(0, 'Alpha\nBeta\nGamma');
const beta = createAgentTextTarget({ text, from: 6, to: 10, replacement: 'Beta by agent' });
text.insert(0, 'User A intro\n');
const applied = operation(doc, [beta]);
assert.equal(applied.status, 'applied_to_ydoc');
assert.equal(text.toString(), 'User A intro\nAlpha\nBeta by agent\nGamma');

const conflictDoc = new Y.Doc({ gc: true });
const conflictText = conflictDoc.getText('content');
conflictText.insert(0, 'First\nSecond');
const first = createAgentTextTarget({ text: conflictText, from: 0, to: 5, replacement: 'Agent first', groupId: 'all' });
const second = createAgentTextTarget({ text: conflictText, from: 6, to: 12, replacement: 'Agent second', groupId: 'all' });
conflictText.delete(6, 6);
conflictText.insert(6, 'User second');
const blocked = operation(conflictDoc, [first, second]);
assert.equal(blocked.status, 'needs_review');
assert.equal(conflictText.toString(), 'First\nUser second', 'all-or-nothing conflict must not apply the safe target');

const independentDoc = new Y.Doc({ gc: true });
const independentText = independentDoc.getText('content');
independentText.insert(0, 'First\nSecond');
const independentFirst = createAgentTextTarget({ text: independentText, from: 0, to: 5, replacement: 'Agent first', groupId: 'one' });
const independentSecond = createAgentTextTarget({ text: independentText, from: 6, to: 12, replacement: 'Agent second', groupId: 'two' });
independentText.delete(6, 6);
independentText.insert(6, 'User second');
const partial = operation(independentDoc, [independentFirst, independentSecond], true);
assert.equal(partial.status, 'partially_applied');
assert.equal(independentText.toString(), 'Agent first\nUser second');

const overlapDoc = new Y.Doc({ gc: true });
const overlapText = overlapDoc.getText('content');
overlapText.insert(0, 'abcdef');
const overlapA = createAgentTextTarget({ text: overlapText, from: 1, to: 4, replacement: 'X', groupId: 'a' });
const overlapB = createAgentTextTarget({ text: overlapText, from: 3, to: 5, replacement: 'Y', groupId: 'b' });
assert.equal(operation(overlapDoc, [overlapA, overlapB], true).status, 'needs_review');
assert.equal(overlapText.toString(), 'abcdef');

const orderingDoc = new Y.Doc({ gc: true });
const orderingText = orderingDoc.getText('content');
orderingText.insert(0, 'one two three');
const firstOrdered = createAgentTextTarget({ text: orderingText, from: 0, to: 3, replacement: 'ONE-LONG', groupId: 'ordered' });
const lastOrdered = createAgentTextTarget({ text: orderingText, from: 8, to: 13, replacement: '3', groupId: 'ordered' });
const ordered = operation(orderingDoc, [firstOrdered, lastOrdered]);
assert.equal(ordered.status, 'applied_to_ydoc');
assert.equal(orderingText.toString(), 'ONE-LONG two 3', 'descending replacements must not shift later target coordinates');

const doubleConflictDoc = new Y.Doc({ gc: true });
const doubleConflictText = doubleConflictDoc.getText('content');
doubleConflictText.insert(0, 'Left\nRight');
const leftTarget = createAgentTextTarget({ text: doubleConflictText, from: 0, to: 4, replacement: 'Agent left', groupId: 'left' });
const rightTarget = createAgentTextTarget({ text: doubleConflictText, from: 5, to: 10, replacement: 'Agent right', groupId: 'right' });
doubleConflictText.delete(0, 4);
doubleConflictText.insert(0, 'User left');
const rightStart = doubleConflictText.toString().indexOf('Right');
doubleConflictText.delete(rightStart, 5);
doubleConflictText.insert(rightStart, 'User right');
const doubleConflict = operation(doubleConflictDoc, [leftTarget, rightTarget], true);
assert.equal(doubleConflict.status, 'needs_review');
assert.deepEqual(
  new Set(doubleConflict.conflicts.map((conflict) => conflict.groupId)),
  new Set(['left', 'right']),
  'both changed targets must retain their own conflict group',
);
assert.equal(doubleConflictText.toString(), 'User left\nUser right');

const imeDoc = new Y.Doc({ gc: true });
const imeText = imeDoc.getText('content');
imeText.insert(0, 'draft composition');
const imeTarget = createAgentTextTarget({ text: imeText, from: 6, to: 17, replacement: 'agent' });
const imeResult = applyAgentTextTargets({
  doc: imeDoc,
  targets: [imeTarget],
  compositionRanges: [{ textName: 'content', from: 6, to: 17 }],
  origin: { actorType: 'agent', actorId: 'agent-b', initiatedByUserId: 'user-b', operationId: randomUUID() },
});
assert.equal(imeResult.status, 'needs_review');
assert.equal(imeResult.conflicts[0]?.code, 'ime_composition');
assert.equal(imeText.toString(), 'draft composition');

const leftBoundaryDoc = new Y.Doc({ gc: true });
const leftBoundaryText = leftBoundaryDoc.getText('content');
leftBoundaryText.insert(0, 'abcd');
const leftBoundaryTarget = createAgentTextTarget({ text: leftBoundaryText, from: 1, to: 3, replacement: 'X' });
leftBoundaryText.insert(1, 'L');
assert.equal(operation(leftBoundaryDoc, [leftBoundaryTarget]).status, 'applied_to_ydoc');
assert.equal(leftBoundaryText.toString(), 'aLXd', 'an insertion at the left boundary must remain outside the target');

const rightBoundaryDoc = new Y.Doc({ gc: true });
const rightBoundaryText = rightBoundaryDoc.getText('content');
rightBoundaryText.insert(0, 'abcd');
const rightBoundaryTarget = createAgentTextTarget({ text: rightBoundaryText, from: 1, to: 3, replacement: 'X' });
rightBoundaryText.insert(3, 'R');
assert.equal(operation(rightBoundaryDoc, [rightBoundaryTarget]).status, 'applied_to_ydoc');
assert.equal(rightBoundaryText.toString(), 'aXRd', 'an insertion at the right boundary must remain outside the target');

doc.destroy(); conflictDoc.destroy(); independentDoc.destroy(); overlapDoc.destroy();
orderingDoc.destroy(); doubleConflictDoc.destroy(); imeDoc.destroy();
leftBoundaryDoc.destroy(); rightBoundaryDoc.destroy();
console.log('file-agent-coauthoring-test: ok');
