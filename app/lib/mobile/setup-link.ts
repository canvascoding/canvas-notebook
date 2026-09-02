export const MOBILE_APP_STORE_URL = 'https://apps.apple.com/app/id6794582516';
export const MOBILE_SETUP_ORIGIN = 'https://canvasnotebook.app';

const MOBILE_INSTANCE_ID_PATTERN = /^cni_[a-f0-9]{24}$/u;

export type MobileSetupCompatibility = {
  product: 'canvas-notebook';
  instance: {
    id: string;
    name: string;
  };
};

export function isMobileSetupCompatibility(value: unknown): value is MobileSetupCompatibility {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MobileSetupCompatibility>;
  return candidate.product === 'canvas-notebook'
    && Boolean(candidate.instance)
    && typeof candidate.instance?.name === 'string'
    && candidate.instance.name.trim().length > 0
    && typeof candidate.instance.id === 'string'
    && MOBILE_INSTANCE_ID_PATTERN.test(candidate.instance.id);
}

export function createMobileSetupLink(serverUrl: string, instanceId: string): string {
  const parsedServer = new URL(serverUrl);
  if (
    parsedServer.protocol !== 'https:'
    || parsedServer.username
    || parsedServer.password
    || parsedServer.search
    || parsedServer.hash
    || !MOBILE_INSTANCE_ID_PATTERN.test(instanceId)
  ) {
    throw new Error('A mobile setup link requires a secure Canvas server and a valid public instance ID.');
  }

  const pathname = parsedServer.pathname.replace(/\/+$/u, '');
  const normalizedServerUrl = `${parsedServer.origin}${pathname === '/' ? '' : pathname}`;
  return `${MOBILE_SETUP_ORIGIN}/connect#v=1&server=${encodeURIComponent(normalizedServerUrl)}&instance=${instanceId}`;
}
