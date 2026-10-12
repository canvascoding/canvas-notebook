import type { HeldCapabilityPackageRuntimeBinding } from '@/app/lib/capabilities/packages/runtime-bindings';

export const SKILL_SCRIPT_MANIFEST_PATH = '.canvas-skill/runtime.json';
export const SKILL_SCRIPT_CONTRACT_VERSION = 1 as const;
export const SKILL_SCRIPT_LIMITS = Object.freeze({
  manifestBytes: 256 * 1024,
  scripts: 16,
  toolAliases: 16,
  outputs: 32,
  dependencies: 32,
  idLength: 64,
  pathLength: 1024,
  displayNameLength: 128,
  descriptionLength: 2048,
});

export type SkillScriptJsonSchema = Record<string, unknown> | boolean;
export type SkillScriptRuntime = Readonly<{ kind: 'node' | 'python'; minimumVersion?: string }>;
export type SkillScriptToolRequirement = Readonly<
  { alias: string; kind: 'native'; toolName: string }
  | { alias: string; kind: 'integration'; source: 'mcp' | 'composio'; application?: string; toolName: string }
>;
export type SkillScriptDeclaration = Readonly<{
  id: string;
  displayName?: string;
  description?: string;
  runtime: SkillScriptRuntime;
  path: string;
  argumentsSchema: SkillScriptJsonSchema;
  tools: readonly SkillScriptToolRequirement[];
  outputs: readonly string[];
  dependencies?: readonly Readonly<{ kind: 'bundled'; path: string }>[];
}>;
export type SkillScriptManifest = Readonly<{ version: 1; scripts: readonly SkillScriptDeclaration[] }>;

/** Server-only exact child root and private 5a binding; never serialize these paths/proofs to the model. */
export type AuthorizedSkillScript = Readonly<{
  scriptRef: string;
  binding: HeldCapabilityPackageRuntimeBinding;
  declaration: SkillScriptDeclaration;
  packageRoot: string;
  entryPath: string;
  manifestChecksum: string;
}>;

export const SKILL_SCRIPT_ERROR_CODES = [
  'SCRIPT_MANIFEST_INVALID', 'SCRIPT_NOT_FOUND', 'SCRIPT_ACCESS_DENIED', 'SCRIPT_PACKAGE_CHANGED',
  'SCRIPT_SCHEMA_UNSUPPORTED', 'SCRIPT_ARGUMENTS_INVALID', 'SCRIPT_RUNTIME_UNAVAILABLE',
  'SCRIPT_SANDBOX_UNAVAILABLE', 'SCRIPT_PROTOCOL_INVALID', 'SCRIPT_TOOL_DENIED',
  'SCRIPT_OUTPUT_INVALID', 'SCRIPT_LIMIT_EXCEEDED', 'SCRIPT_ABORTED', 'SCRIPT_TIMEOUT',
  'SCRIPT_EXECUTION_FAILED', 'SCRIPT_OUTCOME_UNKNOWN',
] as const;
export type SkillScriptErrorCode = typeof SKILL_SCRIPT_ERROR_CODES[number];
const errorBrand = Symbol.for('canvas.skill-script.error.v1');

export class SkillScriptError extends Error {
  constructor(readonly code: SkillScriptErrorCode, message: string, readonly status = 400) {
    super(message);
    this.name = 'SkillScriptError';
    Object.defineProperty(this, errorBrand, { value: true, enumerable: false });
  }
}

export function isSkillScriptError(value: unknown): value is SkillScriptError {
  return value instanceof Error && Reflect.get(value, errorBrand) === true
    && SKILL_SCRIPT_ERROR_CODES.includes(Reflect.get(value, 'code') as SkillScriptErrorCode)
    && Number.isInteger(Reflect.get(value, 'status'));
}
