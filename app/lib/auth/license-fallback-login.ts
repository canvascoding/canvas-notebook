export const TEAM_LICENSE_ACCESS_PAUSED = 'TEAM_LICENSE_ACCESS_PAUSED';

export async function translateLicenseFallbackSignInResponse(
  request: Request,
  response: Response,
  isLicenseFallbackUser: (email: string) => Promise<boolean>,
): Promise<Response> {
  if (new URL(request.url).pathname !== '/api/auth/sign-in/email' || response.status !== 403) {
    return response;
  }

  const error = await response.clone().json().catch(() => null) as { code?: unknown } | null;
  if (error?.code !== 'BANNED_USER') return response;

  const body = await request.clone().json().catch(() => null) as { email?: unknown } | null;
  if (typeof body?.email !== 'string') return response;
  const email = body.email.trim().toLowerCase();
  if (!email) return response;
  try {
    if (!(await isLicenseFallbackUser(email))) return response;
  } catch {
    return response;
  }

  return Response.json({
    code: TEAM_LICENSE_ACCESS_PAUSED,
    message: 'Team access is paused because the organization license is no longer active. Contact your administrator.',
  }, { status: 403, headers: { 'cache-control': 'no-store' } });
}
