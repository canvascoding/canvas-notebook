export function licenseHostingVariant(status: {
  runtimeDeploymentMode?: string | null;
  hostingMode?: string | null;
  deploymentMode?: string | null;
  plan?: string;
} | null): 'managed' | 'self-hosted' | null {
  if (!status) return null;
  const mode = (status.runtimeDeploymentMode ?? status.deploymentMode)?.trim().toLowerCase().replaceAll('_', '-');
  if (status.runtimeDeploymentMode) return mode?.startsWith('managed-') ? 'managed' : 'self-hosted';
  if (!status.hostingMode && !status.plan && !mode) return null;
  return status.hostingMode === 'cloud' || status.plan === 'managed' || mode?.startsWith('managed-')
    ? 'managed' : 'self-hosted';
}
