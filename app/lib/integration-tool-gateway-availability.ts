import { readFileSync } from 'node:fs';

import { serverPreferencesPath } from './terminal-policy';

export type IntegrationToolGatewayAvailability = {
  integrationToolGatewayEnabled: boolean;
  updatedAt: string | null;
};

export function readIntegrationToolGatewayAvailability(): IntegrationToolGatewayAvailability {
  try {
    const { settings } = JSON.parse(readFileSync(serverPreferencesPath(), 'utf8'));
    const updatedAt = typeof settings?.integrationToolGatewayUpdatedAt === 'string'
      && Number.isFinite(Date.parse(settings.integrationToolGatewayUpdatedAt)) ? settings.integrationToolGatewayUpdatedAt : null;
    return {
      integrationToolGatewayEnabled: settings?.integrationToolGatewayEnabled === true
        && (settings?.integrationToolGatewayUpdatedAt === undefined || updatedAt !== null),
      updatedAt,
    };
  } catch {
    return { integrationToolGatewayEnabled: false, updatedAt: null };
  }
}
