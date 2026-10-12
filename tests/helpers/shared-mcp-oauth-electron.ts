import { launchOwnedSharedOAuthElectron, readOwnedSharedOAuthElectronReceipt, closeOwnedSharedOAuthElectron,
  type SharedOAuthElectronDesktopPaths, type OwnedSharedOAuthElectronReceipt, type OwnedSharedOAuthElectron } from './shared-oauth-electron';

export type SharedMcpElectronDesktopPaths = SharedOAuthElectronDesktopPaths;
export type OwnedSharedMcpElectronReceipt = OwnedSharedOAuthElectronReceipt;
export type OwnedSharedMcpElectron = OwnedSharedOAuthElectron;

/** Preserve the existing MCP-only fixture entry point and environment contract. */
export async function launchOwnedSharedMcpElectron(input: { fixturePath: string; providerOrigin: string }): Promise<OwnedSharedMcpElectron> {
  return launchOwnedSharedOAuthElectron(input, 'mcp');
}
export async function readOwnedSharedMcpElectronReceipt(harness: OwnedSharedMcpElectron): Promise<OwnedSharedMcpElectronReceipt> {
  return readOwnedSharedOAuthElectronReceipt(harness, 'mcp');
}
export async function closeOwnedSharedMcpElectron(harness: OwnedSharedMcpElectron): Promise<{ processId: number; processGroupId: number; closed: true }> {
  return closeOwnedSharedOAuthElectron(harness, 'mcp');
}
