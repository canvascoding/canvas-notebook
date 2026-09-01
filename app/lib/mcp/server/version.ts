import 'server-only';

import packageJson from '@/package.json';

// This is the Canvas Notebook release version, distinct from the separately
// negotiated MCP protocol version.
export const DIRECT_MCP_SERVER_VERSION = packageJson.version;
