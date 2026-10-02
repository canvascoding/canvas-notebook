import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { resolveEffectiveCapabilitySnapshot } from '@/app/lib/capabilities/catalog';
import { resolveCapabilityExecutionContextForUser } from '@/app/lib/capabilities/request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import type { CanvasPluginInstallRecord } from '@/app/lib/plugins/canvas-plugin-registry';
import { readExactInstalledPlugin } from '@/app/lib/plugins/installed-plugin-read';
import {
  isValidCanvasPluginName,
  isValidCanvasPluginVersion,
  type CanvasPluginMcpConnector,
} from '@/app/lib/plugins/canvas-plugin-manifest';
import { readCanvasPluginStoreMcpTemplate } from '@/app/lib/plugins/canvas-plugin-store';
import { readPluginMcpTemplateFile } from '@/app/lib/plugins/plugin-mcp-template-service';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeInstalledMcpConnectors(connectors: CanvasPluginInstallRecord['connectors']): CanvasPluginMcpConnector[] {
  return [
    ...(connectors?.mcp || []),
    ...(connectors?.mcpServers ? [{ name: 'mcp', label: 'MCP', configPath: connectors.mcpServers, recommended: true }] : []),
  ];
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json() as {
      source?: unknown;
      name?: unknown;
      version?: unknown;
      connector?: unknown;
      scope?: unknown;
      resourceId?: unknown;
      workspaceId?: unknown;
    };
    const source = body.source === 'store'
      ? 'store'
      : body.source === 'installed' || body.source === undefined
        ? 'installed'
        : null;
    const pluginName = stringValue(body.name);
    const connectorName = stringValue(body.connector);
    const version = stringValue(body.version);
    const resourceId = stringValue(body.resourceId);

    if (!source) {
      return NextResponse.json({ success: false, error: 'Invalid plugin source' }, { status: 400 });
    }
    if (!pluginName || !isValidCanvasPluginName(pluginName)) {
      return NextResponse.json({ success: false, error: 'Invalid plugin name' }, { status: 400 });
    }
    if (version && !isValidCanvasPluginVersion(version)) {
      return NextResponse.json({ success: false, error: 'Invalid plugin version' }, { status: 400 });
    }
    if (!connectorName) {
      return NextResponse.json({ success: false, error: 'MCP connector name is required' }, { status: 400 });
    }
    if (body.resourceId !== undefined && (!resourceId || resourceId.length > 512)) {
      return NextResponse.json({ success: false, error: 'Invalid plugin resource identity' }, { status: 400 });
    }

    if (source === 'store') {
      const template = await readCanvasPluginStoreMcpTemplate(pluginName, version, connectorName);
      return NextResponse.json({ success: true, template });
    }

    const organizationState = await readOrganizationPermissionForUser(session.user.id);
    if (body.scope === 'organization') {
      if (!resourceId || !organizationState.organizationId || organizationState.permission?.status !== 'active') {
        return NextResponse.json({ success: false, error: 'Assigned organization plugin access required' }, { status: 403 });
      }
      try {
        const executionContext = await resolveCapabilityExecutionContextForUser({
          userId: session.user.id,
          organizationId: organizationState.organizationId,
          role: organizationState.permission.role,
          requestedWorkspaceId: stringValue(body.workspaceId) || request.headers.get(WORKSPACE_ID_HEADER),
        });
        const snapshot = organizationState.permission.canSharePluginsAndSkills === true
          ? null : await resolveEffectiveCapabilitySnapshot(executionContext);
        const assignedPlugin = snapshot?.capabilities.find((entry) => (
          entry.ref.resourceType === 'plugin'
          && entry.ref.scopeType === 'organization'
          && entry.ref.resourceId === resourceId
          && entry.ref.name === pluginName
          && entry.effectivePolicy !== 'blocked'
          && entry.readiness !== 'conflict'
        ));
        if (snapshot && !assignedPlugin) {
          return NextResponse.json({ success: false, error: 'Assigned organization plugin access required' }, { status: 403 });
        }
      } catch {
        return NextResponse.json({ success: false, error: 'Assigned plugin is unavailable in this workspace' }, { status: 403 });
      }
    }
    const plugin = await readExactInstalledPlugin({
      name: pluginName,
      resourceId,
      scope: body.scope === 'organization'
        ? { scopeType: 'organization', organizationId: organizationState.organizationId! }
        : { scopeType: 'user', userId: session.user.id },
    });
    if (!plugin) {
      return NextResponse.json({ success: false, error: 'Plugin not found' }, { status: 404 });
    }

    const connector = normalizeInstalledMcpConnectors(plugin.connectors).find((entry) => entry.name === connectorName);
    if (!connector) {
      return NextResponse.json({ success: false, error: 'MCP connector not found' }, { status: 404 });
    }

    if (!connector.configPath) {
      return NextResponse.json({
        success: true,
        template: {
          pluginName: plugin.name,
          version: plugin.version,
          connector,
        },
      });
    }

    const templateFile = await readPluginMcpTemplateFile({
      rootDir: plugin.installDir,
      configPath: connector.configPath,
    });
    return NextResponse.json({
      success: true,
      template: {
        pluginName: plugin.name,
        version: plugin.version,
        connector,
        rawContent: templateFile.rawContent,
        config: templateFile.config,
      },
    });
  } catch (error) {
    console.error('[Plugins MCP Template API] Error:', error);
    const message = error instanceof Error ? error.message : 'Failed to load MCP template';
    return NextResponse.json(
      { success: false, error: message },
      { status: message === 'Invalid connector config path.' ? 400 : 500 },
    );
  }
}
