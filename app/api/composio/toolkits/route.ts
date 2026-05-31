import { NextRequest, NextResponse } from 'next/server';
import { getGatewayStatus, getGatewayToolkits } from '@/app/lib/composio/composio-gateway';

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
  return {
    slug,
    name,
    connected: Boolean(record.connected),
    toolsCount: toolsCount ?? (Array.isArray(record.tools) ? record.tools.length : 0),
  };
}

export async function GET(request: NextRequest) {
  try {
    const connectedOnly = request.nextUrl.searchParams.get('connectedOnly') === '1';
    const summaryOnly = request.nextUrl.searchParams.get('summary') === '1';

    if (connectedOnly) {
      const status = await getGatewayStatus();
      return NextResponse.json({
        toolkits: status.connectedAccounts.map((account) => ({
          slug: account.toolkit.slug,
          name: account.toolkit.name || account.toolkit.slug,
          connected: true,
          connectedAccountStatus: account.status,
          toolsCount: 0,
        })),
      });
    }

    const result = await getGatewayToolkits();
    if (summaryOnly && Array.isArray(result.toolkits)) {
      return NextResponse.json({
        ...result,
        toolkits: result.toolkits.map(toToolkitSummary),
      });
    }

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ toolkits: [], error: message }, { status: 500 });
  }
}
