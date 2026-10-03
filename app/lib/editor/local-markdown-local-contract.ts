/** Plain transport data; schema and codec validation belong to the browser. */
export type LocalMarkdownJSONValue = null | boolean | number | string
  | LocalMarkdownJSONValue[] | { [key: string]: LocalMarkdownJSONValue };
export type LocalMarkdownRichDocumentJSON = { [key: string]: LocalMarkdownJSONValue };
export type LocalMarkdownRichSelectionJSON = { type: string; [key: string]: LocalMarkdownJSONValue };
export type LocalMarkdownSourceSelection = {
  anchor: number;
  head: number;
  ranges?: { anchor: number; head: number }[];
  mainIndex?: number;
};
export type LocalMarkdownEditOptions = { group?: string | null; time?: number };
export type LocalMarkdownSourceEdit = LocalMarkdownEditOptions & {
  revision: number;
  markdown: string;
  beforeSelection: LocalMarkdownSourceSelection;
  afterSelection: LocalMarkdownSourceSelection;
};

/** Owner epochs are unique even when a new owner reuses the same scope. */
export type LocalMarkdownLocalViewIdentity = { scope: string; ownerEpoch: string; viewLease: number };
export type LocalMarkdownLocalRichState = {
  markdown: string;
  document: LocalMarkdownRichDocumentJSON;
  selection: LocalMarkdownRichSelectionJSON;
};
export type LocalMarkdownLocalRichEdit = LocalMarkdownEditOptions & {
  identity: LocalMarkdownLocalViewIdentity;
  sequence: number;
  revision: number;
  before: LocalMarkdownLocalRichState;
  after: LocalMarkdownLocalRichState;
};
export type LocalMarkdownLocalEditAck = {
  identity: LocalMarkdownLocalViewIdentity;
  acceptedThrough: number;
  revision: number;
  accepted: boolean;
};
/** A flush confirms the contiguous accepted prefix from this exact view lease. */
export type LocalMarkdownLocalFlush = { identity: LocalMarkdownLocalViewIdentity; acceptedThrough: number };
