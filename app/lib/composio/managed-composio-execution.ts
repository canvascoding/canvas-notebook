export type ManagedComposioExecuteDependencies = {
  execute: () => Promise<Record<string, unknown>>;
  createOAuthFlow: () => Promise<{ state: string; callbackUrl: string; expiresAt: Date }>;
  connect: (returnUrl: string) => Promise<Record<string, unknown>>;
};

export async function executeManagedComposioTool(dependencies: ManagedComposioExecuteDependencies): Promise<Record<string, unknown>> {
  const result = await dependencies.execute();
  if (result.auth_required !== true) return result;
  const flow = await dependencies.createOAuthFlow();
  const connected = await dependencies.connect(flow.callbackUrl);
  const redirectUrl = typeof connected.redirectUrl === 'string' ? connected.redirectUrl : null;
  return {
    ...result,
    redirect_url: redirectUrl,
    redirectUrl,
    flowId: flow.state,
    expiresAt: flow.expiresAt.toISOString(),
  };
}
