import { Buffer } from 'node:buffer';
import YAML from 'yaml';
import { z } from 'zod';
import { CAPABILITY_WORKFLOW_LIMITS, isWorkflowManifestError, parseWorkflowManifest,
  validateWorkflowConnectorReferences, workflowApplicationSchema, workflowManifestV1Schema,
  workflowMcpConnectorDescriptorSchema, workflowToolNameSchema } from '@/app/lib/capabilities/workflow-contracts';

export const CREATOR_PLUGIN_MANIFEST_SCHEMA_VERSION = 1 as const;
export const CREATOR_PLUGIN_MANIFEST_SCHEMA_ID = 'urn:canvas:creator-plugin-manifest:1';
export const CREATOR_PLUGIN_MANIFEST_MAX_BYTES = CAPABILITY_WORKFLOW_LIMITS.documentBytes;

const text = (max: number) => z.string().min(1).max(max).regex(/^(?!\s)(?![\s\S]*\s$)[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/u);
const localPath = z.string().min(1).max(256)
  .regex(/^(?:\.\/)?(?!\.{1,2}(?:\/|$))[^/\\:\u0000-\u0020\u007f]+(?:\/(?!\.{1,2}(?:\/|$))[^/\\:\u0000-\u0020\u007f]+)*$/u);
const version = z.string().min(1).max(200)
  // Exactly three components, retaining the existing runtime's supported suffix syntax.
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/u);
const composioConnector = z.object({ toolkit: workflowApplicationSchema, label: text(200).optional(),
  reason: text(1024).optional(), recommended: z.boolean().optional(), required: z.boolean().optional(),
  tools: z.array(workflowToolNameSchema).max(CAPABILITY_WORKFLOW_LIMITS.requiredTools).optional(),
}).strict();
const emailConnector = z.object({ kind: z.literal('mailbox').optional(), label: text(200).optional(),
  reason: text(1024).optional(), recommended: z.boolean().optional(), required: z.boolean().optional(),
  providers: z.array(z.enum(['gmail', 'imap-smtp'])).min(1).max(2).optional(),
}).strict();

/** New Creator manifests use this strict input contract. Legacy readers retain their own compatibility behavior. */
export const creatorPluginManifestSchema = z.object({
  schemaVersion: z.literal(CREATOR_PLUGIN_MANIFEST_SCHEMA_VERSION),
  name: z.string().min(1).max(64).regex(/^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
  version,
  description: text(1024),
  skills: z.union([z.literal('.'), localPath]),
  license: text(200).optional(),
  author: z.object({ name: text(200).optional(), url: z.string().max(2048).url().optional() }).strict().optional(),
  source: text(2048).optional(),
  interface: z.object({
    displayName: text(200), shortDescription: text(1024),
    logo: localPath.regex(/\.svg$/u),
    category: text(100).optional(), brandColor: z.string().regex(/^#[a-fA-F0-9]{6}$/u).optional(),
    icon: localPath.optional(), defaultPrompt: z.array(text(4000)).min(1).max(16).optional(),
  }).strict(),
  connectors: z.object({
    composio: z.array(composioConnector).max(CAPABILITY_WORKFLOW_LIMITS.capabilities).optional(),
    email: z.array(emailConnector).max(8).optional(),
    mcp: z.array(workflowMcpConnectorDescriptorSchema).max(CAPABILITY_WORKFLOW_LIMITS.mcpConnectors).optional(),
  }).strict().optional(),
  workflow: workflowManifestV1Schema.optional(),
}).strict();

export type CreatorPluginManifest = z.infer<typeof creatorPluginManifestSchema>;
export type CreatorPluginManifestIssue = Readonly<{ code: string; path: string; message: string; repair: string }>;
export type CreatorPluginManifestValidation = Readonly<{
  valid: boolean;
  issues: readonly CreatorPluginManifestIssue[];
  manifest?: CreatorPluginManifest;
}>;

/** Generated from the same structural schema. Package files, cross references and uniqueness also need runtime validation. */
export const creatorPluginManifestJsonSchema = {
  ...z.toJSONSchema(creatorPluginManifestSchema, { target: 'draft-7', io: 'input' }),
  $id: CREATOR_PLUGIN_MANIFEST_SCHEMA_ID,
  title: 'Canvas Creator Plugin Manifest V1',
  $comment: 'Structural input contract. The existing complete package validator additionally checks uniqueness, references and exact package files; Creator validation also checks actual SVG bytes. Schema validity supplies no connection or execution authority.',
};

/** Validated by the same contract; creators must replace its example metadata and supply actual files. */
export const creatorPluginManifestTemplate: CreatorPluginManifest = creatorPluginManifestSchema.parse({
  schemaVersion: 1, name: 'example-plugin', version: '1.0.0', description: 'Describe the useful task this plugin performs.',
  skills: './skills', interface: { displayName: 'Example Plugin', shortDescription: 'Describe its result for the user.', logo: './assets/logo.svg' },
});

function issue(code: string, field: string, message: string, repair: string): CreatorPluginManifestValidation {
  return { valid: false, issues: [{ code, path: field, message, repair }] };
}

/** Validate original bounded JSON before the compatibility parser can normalize aliases or discard invalid fields. */
export function validateCreatorPluginManifest(rawText: string): CreatorPluginManifestValidation {
  if (Buffer.byteLength(rawText, 'utf8') > CREATOR_PLUGIN_MANIFEST_MAX_BYTES) {
    return issue('CREATOR_MANIFEST_LIMIT', '', 'The plugin manifest exceeds its size limit.', 'Keep the manifest at or below 262144 UTF-8 bytes.');
  }
  let value: unknown;
  try { value = JSON.parse(rawText); }
  catch { return issue('CREATOR_MANIFEST_JSON', '', 'The plugin manifest must be valid JSON.', 'Repair the JSON syntax in .canvas-plugin/plugin.json.'); }
  // JSON.parse alone silently accepts duplicate keys, including escaped spellings.
  const document = YAML.parseDocument(rawText, { strict: true, uniqueKeys: true });
  if (document.errors.length) {
    return issue('CREATOR_MANIFEST_JSON', '', 'The plugin manifest contains duplicate or invalid JSON fields.', 'Use each JSON field exactly once at its object level.');
  }
  const parsed = creatorPluginManifestSchema.safeParse(value);
  if (!parsed.success) {
    return { valid: false, issues: parsed.error.issues.slice(0, 32).map(error => ({ code: 'CREATOR_MANIFEST_SCHEMA',
      path: error.path.map(String).join('.'), message: 'The manifest field does not match the Creator Plugin V1 contract.',
      repair: error.code === 'unrecognized_keys' ? 'Remove unsupported fields and use the canonical camelCase contract.'
        : 'Supply the required field with the type, bounds and value shown in the Creator Plugin V1 schema.',
    })) };
  }
  const manifest = parsed.data;
  const duplicates: CreatorPluginManifestIssue[] = [];
  const unique = (values: readonly string[], field: string) => {
    if (new Set(values).size !== values.length) duplicates.push({ code: 'CREATOR_MANIFEST_DUPLICATE', path: field,
      message: 'Duplicate declarations are not allowed.', repair: 'Keep one unambiguous declaration per identity.' });
  };
  unique(manifest.connectors?.mcp?.map(connector => connector.name) ?? [], 'connectors.mcp');
  unique(manifest.connectors?.composio?.map(connector => connector.toolkit) ?? [], 'connectors.composio');
  for (const [index, connector] of (manifest.connectors?.mcp ?? []).entries()) unique(connector.env ?? [], `connectors.mcp.${index}.env`);
  for (const [index, connector] of (manifest.connectors?.composio ?? []).entries()) unique(connector.tools ?? [], `connectors.composio.${index}.tools`);
  for (const [index, connector] of (manifest.connectors?.email ?? []).entries()) unique(connector.providers ?? [], `connectors.email.${index}.providers`);
  if (duplicates.length) return { valid: false, issues: duplicates };
  try {
    if (manifest.workflow) {
      const workflow = parseWorkflowManifest(value && typeof value === 'object' ? Reflect.get(value, 'workflow') : undefined);
      validateWorkflowConnectorReferences(workflow, manifest.connectors?.mcp ?? []);
    }
  } catch (error) {
    if (!isWorkflowManifestError(error)) throw error;
    return issue('CREATOR_MANIFEST_WORKFLOW', 'workflow', 'The workflow declaration or connector reference is invalid.',
      'Use the shared Workflow V1 contract, unique declarations, and exact package MCP connector names.');
  }
  return { valid: true, issues: [], manifest };
}
