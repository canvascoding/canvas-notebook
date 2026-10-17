import { z } from 'zod';
import { workflowMcpConnectorDescriptorSchema } from '../workflow-contracts';

export type CapabilityPackageAuthoringSkillSource = { resourceRef: string; revisionRef?: string; expectedChecksum: string; childRelativeRoot?: string };
export type CapabilityPackageAuthoringSource = {
  source: { resourceRef: string; revisionRef?: string; expectedChecksum: string };
  skills: Array<{ name: string; title: string; description: string; version: string; source: CapabilityPackageAuthoringSkillSource }>;
};
export const capabilityPackageRequirementInputSchema = z.object({
  expectedDraftRevision: z.number().int().positive(), catalogId: z.string().min(1).max(1024).regex(/^[^\p{Cc}\p{Cf}]+$/u),
  connectorName: workflowMcpConnectorDescriptorSchema.shape.name.optional(), required: z.boolean(),
}).strict();
export type CapabilityPackageAuthoringRequirement = { kind: 'integration'; toolkit: string; required: boolean }
  | { kind: 'mcp'; name: string; required: boolean };
