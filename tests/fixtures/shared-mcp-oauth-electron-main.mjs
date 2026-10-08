import { runOwnedSharedOAuthElectronMain } from './shared-oauth-electron-runtime.mjs';

// Preserve the existing MCP-only entry and its original private control name.
await runOwnedSharedOAuthElectronMain('mcp');
