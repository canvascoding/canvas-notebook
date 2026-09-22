/** Pure URL policy shared by server updates and the page's CSP. */
export const DEFAULT_MANAGED_CONTROL_PLANE_URL = 'https://api.canvasnotebook.app';

export function hasManagedSystemUpdateIntent(env: NodeJS.ProcessEnv): boolean {
  return env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' || env.CANVAS_MANAGED_SERVICES_ENABLED === '1' ||
    Boolean(env.CANVAS_INSTANCE_TOKEN?.trim());
}

export function getManagedSystemUpdateOrigin(env: NodeJS.ProcessEnv): string {
  const configured = env.CANVAS_CONTROL_PLANE_URL || env.NEXT_PUBLIC_CANVAS_CONTROL_PLANE_URL || DEFAULT_MANAGED_CONTROL_PLANE_URL;
  const parsed = new URL(configured.trim().replace(/^ws/iu, 'http'));
  if (parsed.pathname === '/agent') parsed.pathname = '/';
  const localHttp = env.CANVAS_UPDATE_ALLOW_LOCAL_HTTP === 'true' &&
    ['localhost', '127.0.0.1', '[::1]', 'host.orb.internal', 'host.docker.internal'].includes(parsed.hostname);
  // URL.host alone is insufficient for CSP: URL accepts wildcard and semicolon hosts.
  const concreteHostname = /^(?:[a-z\d.-]+|\[[a-f\d:]+\])$/iu.test(parsed.hostname);
  if (!concreteHostname || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' ||
      (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localHttp))) {
    throw new Error('Managed updates require an HTTPS Control Plane origin. Local HTTP requires CANVAS_UPDATE_ALLOW_LOCAL_HTTP=true and an allowed local host.');
  }
  return parsed.origin;
}
