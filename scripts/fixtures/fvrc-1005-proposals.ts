import * as Y from 'yjs';

import { createAgentTextTarget } from '../../app/lib/collaboration/agent-operations';
import { authorProposalYjsCandidate, type AuthoredProposalYjsCandidate } from '../../app/lib/file-version-center/proposal-yjs-candidate';

export const PROPOSAL_IDS = ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10'] as const;
export type FixtureProposalId = typeof PROPOSAL_IDS[number];
export const BASE_TEXT = 'A0|B0|C0|D0|E0|F0|G0|H0|I0|J0';

export type FixtureProposal = {
  id: string;
  from: string;
  replacement: string;
  parentId: string | null;
};

/** The primary fixture is deliberately ten independent, non-overlapping proposals. */
export const PROPOSALS: readonly FixtureProposal[] = PROPOSAL_IDS.map((id, index) => {
  const letter = String.fromCharCode('A'.charCodeAt(0) + index);
  return { id, from: `${letter}0`, replacement: `${letter}1`, parentId: null };
});

export function createBaseUpdate(): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  doc.getText('content').insert(0, BASE_TEXT);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

export function author(update: Uint8Array, proposal: FixtureProposal): AuthoredProposalYjsCandidate {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, update);
  const text = doc.getText('content');
  const from = text.toString().indexOf(proposal.from);
  if (from < 0) throw new Error(`fixture target not found: ${proposal.id}`);
  const result = authorProposalYjsCandidate({
    representation: 'plain_text',
    sourceUpdate: update,
    targets: [createAgentTextTarget({
      text,
      from,
      to: from + proposal.from.length,
      replacement: proposal.replacement,
    })],
  });
  doc.destroy();
  return result;
}

/** Independent fixed end oracle: no Yjs IDs, proofs, or candidate output are consulted. */
export function oracleApply(text: string, proposal: FixtureProposal): string {
  const from = text.indexOf(proposal.from);
  if (from < 0) throw new Error(`oracle target not found: ${proposal.id}`);
  return text.slice(0, from) + proposal.replacement + text.slice(from + proposal.from.length);
}

export function oracleFor(ids: readonly FixtureProposalId[]): string {
  return ids.reduce((text, id) => oracleApply(text, PROPOSALS.find((proposal) => proposal.id === id)!), BASE_TEXT);
}
