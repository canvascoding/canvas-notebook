import { z } from 'zod';
import { capabilityPackageStoreSelectionSchema, type CapabilityPackageStoreSelection } from './store-contracts';

export const CAPABILITY_PACKAGE_PRESENTATION_LIMITS = Object.freeze({
  bytes: 1024 * 1024, children: 256, capabilities: 512, scripts: 512, requirements: 512,
  compatibility: 256, envNames: 256, title: 256, description: 4096, license: 512,
});
export const capabilityPackageStoreOfferingPresentationSchema = z.object({source: capabilityPackageStoreSelectionSchema}).strict();
export type CapabilityPackagePresentationDeclaration = {kind: 'plugin' | 'skill'; name: string};
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
  source?: CapabilityPackageStoreSelection;
  children: Array<{name: string; title: string; description: string; version?: string}>;
  capabilities: Array<{declaredBy: CapabilityPackagePresentationDeclaration; id: string; application: string; required: boolean;
    alternatives: Array<{source: 'mcp' | 'composio'; label: string}>}>;
  requirements: Array<{declaredBy: CapabilityPackagePresentationDeclaration; source: 'mcp' | 'composio' | 'canvas-email';
    label: string; required: boolean; recommended: boolean}>;
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
