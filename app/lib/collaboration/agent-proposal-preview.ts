/** Display-only context; operation guards and approval tokens remain authoritative. */
export type AgentPreviewLocationReference = {
  type: string;
  text: string;
  truncated: boolean;
  position: number[];
};

export type AgentPreviewBlockLocation = {
  id: string;
  position: number[];
  parent: AgentPreviewLocationReference | null;
  following: AgentPreviewLocationReference | null;
};

export type AgentProposalPreviewMetadata = {
  previewFormat?: 'text' | 'markdown' | 'blocks';
  blockLocations?: { before: AgentPreviewBlockLocation[]; after: AgentPreviewBlockLocation[] };
};
