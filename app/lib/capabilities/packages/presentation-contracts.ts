import { z } from 'zod';
import { capabilityPackageStoreSelectionSchema, type CapabilityPackageStoreSelection } from './store-contracts';

export const CAPABILITY_PACKAGE_PRESENTATION_LIMITS = Object.freeze({
  bytes: 1024 * 1024, children: 256, capabilities: 512, scripts: 512, requirements: 512,
  compatibility: 256, envNames: 256, title: 256, description: 4096, license: 512,
});
export const capabilityPackageStoreOfferingPresentationSchema = z.object({source: capabilityPackageStoreSelectionSchema}).strict();
export type CapabilityPackagePresentationDeclaration = {kind: 'plugin' | 'skill'; name: string};
/** Stable provider identities remain independent of translated display labels. */
export type CapabilityPackageRequirementSelector =
  | {source: 'mcp'; connector: string}
  | {source: 'composio'; toolkit: string};

export const capabilityPackageMcpTemplateQuerySchema = z.object({
  connector: z.string().min(1).max(256).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)),
  expectedChecksum: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();
export type CapabilityPackageMcpTemplate = {
  resourceRef: string;
  declaredBy: CapabilityPackagePresentationDeclaration;
  source: {resourceRef: string; version: string; checksum: string; artifactRevision: number | null};
  connector: {name: string; label?: string; env?: string[]; oauth?: boolean};
  /** Safe setup defaults only. Never source bytes, existing connection secrets or filesystem roots. */
  config?: Record<string, unknown>;
  redactedFields: string[];
};
export type CapabilityPackagePresentation = {
  schemaVersion: 1;
  origin: 'store' | 'installed';
  kind: 'plugin' | 'skill';
  name: string;
  version: string;
  title: string;
  description: string;
  license?: string;
  resourceRef?: string;
  /** Exact readable installed source shown in this presentation; a checksum is not execution authority. */
  sourceStamp?: { checksum: string; artifactRevision: number | null;
    parent?: { resourceRef: string; checksum: string; artifactRevision: number | null } };
  source?: CapabilityPackageStoreSelection;
  children: Array<{name: string; title: string; description: string; version?: string}>;
  capabilities: Array<{declaredBy: CapabilityPackagePresentationDeclaration; id: string; application: string; required: boolean;
    alternatives: Array<{source: 'mcp' | 'composio'; label: string; selector?: CapabilityPackageRequirementSelector}>}>;
  requirements: Array<{declaredBy: CapabilityPackagePresentationDeclaration; source: 'mcp' | 'composio' | 'canvas-email';
    label: string; required: boolean; recommended: boolean; selector?: CapabilityPackageRequirementSelector}>;
  scripts: Array<{skillName: string; id: string; title: string; description?: string;
    runtime: {kind: 'node' | 'python'; minimumVersion?: string}}>;
  compatibility: string[];
  minCanvasVersion?: string;
  /** Declared configuration key names, not a missing-secret or connection-readiness report. */
  requiredEnv: string[];
  readOnly: boolean;
  /** Current Read and exact source were checked for this response; it does not grant execution. */
  sourceStampCurrent: true;
};
