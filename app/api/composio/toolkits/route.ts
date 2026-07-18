import { NextRequest, NextResponse } from 'next/server';
import { getGatewayStatus, getGatewayToolkits } from '@/app/lib/composio/composio-gateway';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';
import { resolveComposioToolkitAccess } from '@/app/lib/composio/composio-toolkit-access';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toToolkitSummary(value: unknown) {
  const record = asRecord(value);
  const slug = stringValue(record.slug);
  const name = stringValue(record.name) || slug;
  const toolsCount = numberValue(record.toolsCount) ?? numberValue(record.toolCount);
  const access = resolveComposioToolkitAccess(record, Boolean(record.connected));
  return {
    slug,
    name,
    logo: stringValue(record.logo),
    noAuth: access.noAuth,
    connected: access.ready,
    toolsCount: toolsCount ?? (Array.isArray(record.tools) ? record.tools.length : 0),
  };
}

function toPublicToolkit(value: unknown) {
  const record = asRecord(value);
  const access = resolveComposioToolkitAccess(record, Boolean(record.connected));
  return {
    ...record,
    noAuth: access.noAuth,
    connected: access.ready,
  };
}

export async function GET(request: NextRequest) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    const composioContext = contextResult.composioContext;
    const connectedOnly = request.nextUrl.searchParams.get('connectedOnly') === '1';
    const summaryOnly = request.nextUrl.searchParams.get('summary') === '1';
    const includeLogos = request.nextUrl.searchParams.get('includeLogos') === '1';

    if (connectedOnly) {
      const status = await getGatewayStatus(composioContext);
      let toolkitSummaryBySlug = new Map<string, ReturnType<typeof toToolkitSummary>>();
      if (includeLogos) {
        const result = await getGatewayToolkits(composioContext).catch(() => ({ toolkits: [] }));
        if (Array.isArray(result.toolkits)) {
          toolkitSummaryBySlug = new Map(
            result.toolkits
              .map(toToolkitSummary)
              .filter((toolkit) => toolkit.slug)
              .map((toolkit) => [toolkit.slug, toolkit]),
          );
        }
      }

      return NextResponse.json({
        toolkits: status.connectedAccounts.map((account) => {
          const toolkit = toolkitSummaryBySlug.get(account.toolkit.slug);
          return {
            slug: account.toolkit.slug,
            name: account.toolkit.name || toolkit?.name || account.toolkit.slug,
            logo: toolkit?.logo || '',
            connected: true,
            connectedAccountStatus: account.status,
            toolsCount: toolkit?.toolsCount || 0,
          };
        }),
      });
    }

    const result = await getGatewayToolkits(composioContext);
    const toolkits = Array.isArray(result.toolkits)
      ? result.toolkits.map(toPublicToolkit)
      : [];
    if (summaryOnly) {
      return NextResponse.json({
        ...result,
        toolkits: toolkits.map(toToolkitSummary),
      });
    }

    return NextResponse.json({ ...result, toolkits });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ toolkits: [], error: message }, { status: 500 });
  }
}
