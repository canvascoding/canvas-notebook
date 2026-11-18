import 'server-only';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import type { AuthInfo, CallToolResult } from '@modelcontextprotocol/server';
import { studioImageParameters } from '@/app/lib/integrations/studio-image-schema';
import { createStudioScope, type StudioScope } from '@/app/lib/integrations/studio-scope';
import { verifyDirectMcpAccessToken, DirectMcpAuthorizationError } from './access-token-verifier';
import { getDirectMcpRuntimeSettings } from './runtime-settings';
import { directMcpToolAuthorizationError } from './tool-auth';
import {
  isDirectMcpReadableWorkspace,
  listDirectMcpAllowedWorkspaceIds,
  listDirectMcpEnabledWorkspaceIds,
  loadDirectMcpWorkspaceListingForUser,
} from './workspace-access-policy';
import type { DirectMcpToolDescriptor } from './tool-descriptor';

const id = Type.String({ minLength: 1, maxLength: 200 });
const catalog = Type.Object(
  { workspaceId: id, referenceSearch: Type.Optional(Type.String({ maxLength: 256 })) },
  { additionalProperties: false },
);
const generate = Type.Object(
  {
    ...studioImageParameters.properties,
    workspaceId: id,
    idempotencyKey: id,
  },
  { additionalProperties: false },
);
const result = Type.Object(
  { workspaceId: id, generationId: id, outputId: Type.Optional(id) },
  { additionalProperties: false },
);
const tools = [
  {
    name: 'studio_image_catalog',
    schema: catalog,
    scope: 'studio:read',
    description:
      'List Studio image models, availability, presets, products, personas, styles and reference image paths for a workspace. Filter reference images by name or path with referenceSearch.',
  },
  {
    name: 'studio_generate_image',
    schema: generate,
    scope: 'studio:generate',
    description:
      'Queue a Studio image generation or edit. May incur provider charges. Use a fresh idempotencyKey for each new request and reuse it for retries. Poll studio_image_result with the generationId. To edit a previous image pass its source_output_id.',
  },
  {
    name: 'studio_image_result',
    schema: result,
    scope: 'studio:read',
    description:
      'Read image generation status and output IDs. Pass one outputId to retrieve the image bytes (a WebP preview for large originals).',
  },
] as const;
type Tool = (typeof tools)[number];
class InputError extends Error {}
function reply(data: Record<string, unknown>): CallToolResult {
  return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
}

async function references(values: string[], scope: StudioScope) {
  const { getStudioWorkspaceVirtualRoot, isValidStudioReferenceId, STUDIO_SYSTEM_PRESETS_DIR } =
    await import('@/app/lib/integrations/studio-workspace');
  const { classifyMediaReference } = await import('@/app/lib/integrations/media-reference-resolver');
  const root = getStudioWorkspaceVirtualRoot(scope.storage);
  return values.map((value) => {
    const queryWorkspace = new URLSearchParams(value.split('?')[1]?.split('#')[0]).get('workspaceId');
    if (queryWorkspace && queryWorkspace !== scope.workspaceId)
      throw new InputError('Invalid workspace image reference.');
    const ref = classifyMediaReference(value, { userId: scope.actorUserId });
    if (!ref || (ref.workspaceId && ref.workspaceId !== scope.workspaceId))
      throw new InputError('Invalid workspace image reference.');
    if (ref.kind === 'external_url' && value.startsWith('https://')) return value;
    const path = ref.relativePath;
    if (
      path.split('/').some((segment) => !segment || segment.startsWith('.') || /[%?#\\\x00-\x1f]/u.test(segment))
    ) {
      throw new InputError('Use a visible workspace-relative image path.');
    }
    if (ref.kind === 'studio_reference') {
      const referenceId = path.split('/').at(-1)!;
      if (!isValidStudioReferenceId(referenceId)) throw new InputError('Invalid Studio reference ID.');
      return root + '/assets/references/' + referenceId;
    }
    if (ref.kind === 'workspace_relative')
      return (
        '/api/media/' +
        path.split('/').map(encodeURIComponent).join('/') +
        '?workspaceId=' +
        encodeURIComponent(scope.workspaceId)
      );
    if (value.startsWith('studio/outputs/')) {
      // The worker verifies the legacy output's workspace ownership before loading it.
      return 'studio/outputs/' + path;
    }
    if (path.startsWith(root + '/') || path.startsWith(STUDIO_SYSTEM_PRESETS_DIR + '/')) return path;
    if (
      ['products', 'personas', 'styles', 'presets', 'references'].includes(path.split('/')[0]) &&
      ref.kind === 'studio_asset'
    )
      return root + '/assets/' + path;
    throw new InputError('Use a reference in the selected workspace, a source_output_id or a public HTTPS image.');
  });
}

async function start(scope: StudioScope, clientId: string, args: Static<typeof generate>) {
  const { workspaceId, idempotencyKey, ...options } = args;
  const { createStudioGeneration, findStudioGenerationByClientRequestId, getStudioOutputForUser } =
    await import('@/app/lib/integrations/studio-generation-service');
  const { assertStudioGenerationQueueCapacity, enqueueStudioGeneration } =
    await import('@/app/lib/integrations/studio-generation-queue');
  const key =
    'mcp-image:' +
    createHash('sha256')
      .update(JSON.stringify([clientId, workspaceId, idempotencyKey]))
      .digest('hex');
  const lookup = () => findStudioGenerationByClientRequestId(scope, key);
  const previous = await lookup();
  if (previous) return reply({ generationId: previous.generationId, status: previous.status, reused: true });
  const { getModelsForProvider, getProvidersForMode } =
    await import('@/app/lib/integrations/image-generation-constants');
  const provider = options.provider ?? 'gemini';
  if (
    !getProvidersForMode('image').some((p) => p.id === provider) ||
    (options.model && !getModelsForProvider('image', provider).some((m) => m.id === options.model))
  )
    throw new InputError('Select an image provider and model from studio_image_catalog.');
  if (options.source_output_id) {
    const source = await getStudioOutputForUser(options.source_output_id, scope);
    if (!source?.mimeType?.startsWith('image/'))
      throw new InputError('Source image is unavailable in this workspace.');
  }
  const urls = await references(options.extra_reference_urls ?? [], scope);
  await assertStudioGenerationQueueCapacity(scope.actorUserId);
  try {
    const job = await createStudioGeneration(scope, {
      ...options,
      provider,
      mode: 'image',
      extra_reference_urls: urls,
      require_all_image_references: true,
      client_request_id: key,
    });
    enqueueStudioGeneration(job.generationId);
    return reply({ generationId: job.generationId, status: 'pending' });
  } catch (error) {
    const concurrent = await lookup();
    if (concurrent)
      return reply({ generationId: concurrent.generationId, status: concurrent.status, reused: true });
    throw error;
  }
}

async function getResult(scope: StudioScope, args: Static<typeof result>) {
  const { getStudioGeneration } = await import('@/app/lib/integrations/studio-generation-service');
  const job = await getStudioGeneration(args.generationId, scope);
  if (!job || job.mode !== 'image') throw new InputError('Image generation is unavailable in this workspace.');
  const metadata = job.metadata ? JSON.parse(job.metadata) : {};
  const message = reply({
    generationId: job.id,
    status: job.status,
    model: job.model,
    ...(job.status === 'failed'
      ? { error: metadata.error, code: metadata.errorCode, retryable: metadata.retryable === true }
      : {}),
    outputs: job.outputs.map((o) => ({
      outputId: o.id,
      mediaUrl: o.mediaUrl,
      mimeType: o.mimeType,
      variationIndex: o.variationIndex,
    })),
  });
  if (args.outputId) {
    const output = job.outputs.find((o) => o.id === args.outputId);
    const { resolveStudioFilePath } = await import('@/app/lib/integrations/studio-workspace');
    const file = output?.filePath && resolveStudioFilePath(output.filePath);
    if (!file) throw new InputError('Unknown image output for this generation.');
    if (
      output?.mimeType &&
      ['image/png', 'image/jpeg', 'image/webp'].includes(output.mimeType) &&
      (await stat(file)).size <= 4 * 1024 * 1024
    ) {
      message.content.push({
        type: 'image',
        mimeType: output.mimeType,
        data: (await readFile(file)).toString('base64'),
      });
      return message;
    }
    const { default: sharp } = await import('sharp');
    const preview = await sharp(file)
      .rotate()
      .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    message.content.push({ type: 'image', mimeType: 'image/webp', data: preview.toString('base64') });
  }
  return message;
}

async function execute(tool: Tool, raw: unknown, auth?: AuthInfo): Promise<CallToolResult> {
  if (!auth?.token) return directMcpToolAuthorizationError(undefined, tool.scope);
  try {
    const principal = await verifyDirectMcpAccessToken(auth.token, [tool.scope]);
    const settings = await getDirectMcpRuntimeSettings();
    if (!settings.enabled || !settings.tools.includes(tool.name))
      throw new InputError('Studio capability disabled.');
    if (!Value.Check(tool.schema, raw)) throw new InputError('Invalid arguments for ' + tool.name);
    const [listing, allowed, enabled] = await Promise.all([
      loadDirectMcpWorkspaceListingForUser(principal.userId),
      listDirectMcpAllowedWorkspaceIds(principal),
      listDirectMcpEnabledWorkspaceIds(),
    ]);
    const workspace = listing.workspaces.find((w) => w.workspaceId === raw.workspaceId);
    if (
      !workspace ||
      !workspace.organizationId ||
      !isDirectMcpReadableWorkspace(workspace) ||
      !workspace.permissions.canRunAgent ||
      !allowed.has(workspace.workspaceId) ||
      !enabled.has(workspace.workspaceId) ||
      (tool.name === 'studio_generate_image' && !workspace.permissions.canWrite)
    )
      throw new InputError('This connection cannot use Studio in the selected workspace.');
    const scope = createStudioScope(principal.userId, workspace);
    const { ensureStudioWorkspaceFilesMigrated } =
      await import('@/app/lib/integrations/studio-workspace-file-migration');
    await ensureStudioWorkspaceFilesMigrated(scope);
    if (tool.name === 'studio_generate_image')
      return await start(scope, principal.clientId, raw as Static<typeof generate>);
    if (tool.name === 'studio_image_result') return await getResult(scope, raw as Static<typeof result>);
    const { getMobileStudioCatalog } = await import('@/app/lib/mobile/studio');
    const { listStudioReferenceAssets } = await import('@/app/lib/integrations/studio-reference-assets');
    const query = (raw as Static<typeof catalog>).referenceSearch?.trim().toLowerCase() ?? '';
    const [studioCatalog, referenceAssets] = await Promise.all([
      getMobileStudioCatalog({
        scope,
        userId: principal.userId,
        canWrite: workspace.permissions.canWrite,
        canDeleteAssets: false,
      }),
      listStudioReferenceAssets(scope, { requestedKind: 'image', query, limit: 100, depth: 8 }),
    ]);
    return reply({
      providers: studioCatalog.modes.find((mode) => mode.id === 'image')?.providers,
      openAIOptions: studioCatalog.options.openAIImage,
      references: referenceAssets.data,
      referenceCount: referenceAssets.total,
      presets: studioCatalog.presets,
      library: studioCatalog.library,
    });
  } catch (error) {
    if (error instanceof DirectMcpAuthorizationError) return directMcpToolAuthorizationError(error, tool.scope);
    const { StudioServiceError } = await import('@/app/lib/integrations/studio-errors');
    const text =
      error instanceof InputError
        ? error.message
        : error instanceof StudioServiceError
          ? error.userMessage
          : 'Studio could not complete this operation.';
    return { isError: true, content: [{ type: 'text', text }] };
  }
}
export function getStudioImageTools() {
  return tools.map((tool) => {
    const securitySchemes = [{ type: 'oauth2' as const, scopes: [tool.scope] }];
    const descriptor: DirectMcpToolDescriptor = {
      name: tool.name,
      description: tool.description,
      inputSchema: JSON.parse(JSON.stringify(tool.schema)) as DirectMcpToolDescriptor['inputSchema'],
      annotations: {
        readOnlyHint: tool.name !== 'studio_generate_image',
        destructiveHint: false,
        openWorldHint: tool.name === 'studio_generate_image',
      },
      securitySchemes,
      _meta: { securitySchemes },
    };
    return { id: tool.name, descriptor, execute: (args: unknown, auth?: AuthInfo) => execute(tool, args, auth) };
  });
}
