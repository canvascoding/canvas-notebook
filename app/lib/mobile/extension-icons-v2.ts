import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { extensionPackagePinSchema } from '@/app/lib/capabilities/extensions/contracts';
import { readAgentExtensionPackageIcon } from '@/app/lib/agents/extension-package-icons';
import { readCapabilityPackageIconAction } from '@/app/lib/capabilities/packages/presentation-actions';
import { readPluginMcpIconAction } from '@/app/lib/plugins/plugin-mcp-icon-action';
import { publicPluginExtensionIcon, type PluginExtensionIcon } from '@/app/lib/plugins/plugin-extension-icons';
import { MOBILE_SCOPED_HEADERS, MobileScopedError, revalidateMobileScopedContext, type MobileScopedContext } from './scoped-route-v2';

const identifier = z.string().min(1).max(1024);
const querySchema = z.discriminatedUnion('kind', [
  extensionPackagePinSchema.extend({ kind: z.literal('published'), childRelativeRoot: z.string().max(1024).optional() }).strict(),
  z.object({ kind: z.literal('installed'), resourceRef: identifier,
    revision: z.string().regex(/^(?:0|[1-9]\d*)$/u).refine(value => Number.isSafeInteger(Number(value))), childName: identifier.optional() }).strict(),
  z.object({ kind: z.literal('mcp'), selectionId: identifier, binding: z.string().min(1).max(4096) }).strict(),
]);

/** Maps only known source-authorized image routes. Relative URLs never become arbitrary native requests. */
function mobileIcon(icon: PluginExtensionIcon, workspaceId: string): PluginExtensionIcon | undefined {
  if (!icon.url.startsWith('/')) {
    const publicIcon = publicPluginExtensionIcon(icon.url, icon.sourceKey);
    return publicIcon ? { ...icon, url: publicIcon.url } : undefined;
  }
  if (icon.url.startsWith('//')) return;
  try {
    const url = new URL(icon.url, 'https://canvas-mobile.invalid'), original = url.searchParams;
    for (const key of original.keys()) if (original.getAll(key).length !== 1) return;
    if (original.has('workspaceId') && original.get('workspaceId') !== workspaceId) return;
    const query = new URLSearchParams(original); query.delete('workspaceId');
    let match;
    if (url.pathname === '/api/agents/extension-options/icon') query.set('kind', 'published');
    else if ((match = /^\/api\/capabilities\/packages\/([^/]+)\/icon$/u.exec(url.pathname))) {
      query.set('kind', 'installed'); query.set('resourceRef', decodeURIComponent(match[1]!));
    } else if ((match = /^\/api\/plugins\/mcp-icons\/([^/]+)$/u.exec(url.pathname))) {
      query.set('kind', 'mcp'); query.set('selectionId', decodeURIComponent(match[1]!));
    } else return;
    const parsed = querySchema.safeParse(Object.fromEntries(query)); if (!parsed.success) return;
    return { ...icon, url: `/api/mobile/v1/extensions/icon?${query}` };
  } catch { return; }
}

/** Public metadata projection only. Exact package/connection identities and source keys stay unchanged. */
export function projectMobileExtensionIcons<T>(value: T, workspaceId: string): T {
  if (Array.isArray(value)) return value.map(item => projectMobileExtensionIcons(item, workspaceId)) as T;
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (typeof record.url === 'string' && typeof record.sourceKey === 'string' && Object.keys(record).every(key => ['url', 'sourceKey'].includes(key))) {
    return mobileIcon(record as PluginExtensionIcon, workspaceId) as T;
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, projectMobileExtensionIcons(item, workspaceId)])) as T;
}

export async function readMobileExtensionIcon(context: MobileScopedContext, request: NextRequest): Promise<NextResponse> {
  const raw = Object.fromEntries(request.nextUrl.searchParams); delete raw.workspaceId;
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) throw new MobileScopedError('INVALID_REQUEST', 'Choose one exact source image.');
  const input = parsed.data, actor = { userId: context.userId, workspaceId: context.workspaceId };
  await revalidateMobileScopedContext(context);
  let bytes: Uint8Array | undefined, contentType: string | undefined;
  if (input.kind === 'mcp') {
    const image = await readPluginMcpIconAction(actor, input.selectionId, input.binding, request.signal);
    if (image) { bytes = new Uint8Array(image.buffer); contentType = image.contentType; }
  } else {
    const image = input.kind === 'published'
      ? await readAgentExtensionPackageIcon(actor, { resourceRef: input.resourceRef, publishedRevisionRef: input.publishedRevisionRef, checksum: input.checksum },
        input.childRelativeRoot === undefined ? {} : { childRelativeRoot: input.childRelativeRoot })
      : await readCapabilityPackageIconAction(actor, input.resourceRef, { revision: input.revision, ...(input.childName ? { childName: input.childName } : {}) });
    // Metadata already supplies sanitized public HTTPS logos directly. Never redirect an authenticated native image request.
    if (image && 'bytes' in image) { bytes = new Uint8Array(image.bytes); contentType = image.contentType; }
  }
  await revalidateMobileScopedContext(context);
  return new NextResponse(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 204, headers: { ...MOBILE_SCOPED_HEADERS,
    'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    ...(contentType ? { 'Content-Type': contentType } : {}) } });
}
