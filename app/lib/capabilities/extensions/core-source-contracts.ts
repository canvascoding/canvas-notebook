import { z } from 'zod';
import { CORE_SKILL_NAMES } from '@/app/lib/skills/core-skills';

/** A bundled source identity is separate from immutable SQL publication pins. */
export const corePluginSourceSchema = z.object({
  resourceRef: z.literal('canvas-capability:v1:plugin:system:core:plugin-creator'),
  coreRevision: z.string().min(1).max(200).regex(/^[0-9]+(?:\.[0-9]+){0,2}(?:[-+][a-z0-9.-]+)?$/iu),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type CorePluginSource = z.infer<typeof corePluginSourceSchema>;

export const corePluginExtensionSelectionSchema = z.object({
  kind: z.literal('core_plugin'), coreSource: corePluginSourceSchema,
}).strict();
export type CorePluginExtensionSelection = z.infer<typeof corePluginExtensionSelectionSchema>;

type CoreSkillResourceRef = `canvas-capability:v1:skill:system:core:${typeof CORE_SKILL_NAMES[number]}`;
const coreSkillRefs = CORE_SKILL_NAMES.map(name => `canvas-capability:v1:skill:system:core:${name}`) as [CoreSkillResourceRef, ...CoreSkillResourceRef[]];
export const coreSkillSourceSchema = corePluginSourceSchema.extend({ resourceRef: z.enum(coreSkillRefs) }).strict();
export type CoreSkillSource = z.infer<typeof coreSkillSourceSchema>;
export const coreSkillExtensionSelectionSchema = z.object({ kind: z.literal('core_skill'), coreSource: coreSkillSourceSchema }).strict();
export type CoreSkillExtensionSelection = z.infer<typeof coreSkillExtensionSelectionSchema>;
export type CoreExtensionSelection = CorePluginExtensionSelection | CoreSkillExtensionSelection;
export type CoreInstructionSource = CorePluginSource | CoreSkillSource;
export const isCoreExtensionSelection = (selection: { kind: string }): selection is CoreExtensionSelection =>
  selection.kind === 'core_plugin' || selection.kind === 'core_skill';
export function coreExtensionSelectionForSource(source: CoreInstructionSource): CoreExtensionSelection {
  const skill = coreSkillSourceSchema.safeParse(source);
  return skill.success ? {kind:'core_skill',coreSource:skill.data} : {kind:'core_plugin',coreSource:corePluginSourceSchema.parse(source)};
}
