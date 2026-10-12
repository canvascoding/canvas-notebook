import { runOwnedSharedOAuthElectronMain } from './shared-oauth-electron-runtime.mjs';

// The complete production Main/preload is imported by the common runtime.
await runOwnedSharedOAuthElectronMain('composio');
