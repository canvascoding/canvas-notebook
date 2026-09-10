import type { McpServerConfig } from './config';

export type McpServerDefinition = {
  version: 1;
  id: string;
  organizationId: string;
  name: string;
  enabled: boolean;
  revision: number;
  config: McpServerConfig;
  updatedAt: string;
};
