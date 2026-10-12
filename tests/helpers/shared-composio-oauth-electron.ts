import { launchOwnedSharedOAuthElectron, readOwnedSharedOAuthElectronReceipt, closeOwnedSharedOAuthElectron,
  type SharedOAuthElectronDesktopPaths, type OwnedSharedOAuthElectronReceipt, type OwnedSharedOAuthElectron } from './shared-oauth-electron';

export type SharedComposioElectronDesktopPaths = SharedOAuthElectronDesktopPaths;
export type OwnedSharedComposioElectronReceipt = OwnedSharedOAuthElectronReceipt & { nativeProvider: 'composio' };
export type OwnedSharedComposioElectron = OwnedSharedOAuthElectron;

/** This literal wrapper cannot select the MCP fixture, IPC channel or status namespace. */
export async function launchOwnedSharedComposioElectron(input: { fixturePath: string; providerOrigin: string }): Promise<OwnedSharedComposioElectron> {
  return launchOwnedSharedOAuthElectron(input, 'composio');
}
export async function readOwnedSharedComposioElectronReceipt(harness: OwnedSharedComposioElectron): Promise<OwnedSharedComposioElectronReceipt> {
  return await readOwnedSharedOAuthElectronReceipt(harness, 'composio') as OwnedSharedComposioElectronReceipt;
}
export async function closeOwnedSharedComposioElectron(harness: OwnedSharedComposioElectron): Promise<{ processId: number; processGroupId: number; closed: true }> {
  return closeOwnedSharedOAuthElectron(harness, 'composio');
}
