import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { user } from '@/app/lib/db/schema';
import { auth } from '@/app/lib/auth';
import { isOnboardingEnabled, isOnboardingComplete, markOnboardingComplete } from '@/app/lib/onboarding/status';

export async function POST(req: NextRequest) {
  if (!isOnboardingEnabled()) {
    return NextResponse.json({ error: 'Onboarding is not enabled' }, { status: 403 });
  }

  if (await isOnboardingComplete()) {
    return NextResponse.json({ error: 'Onboarding already completed' }, { status: 403 });
  }

  const body = await req.json();
  const { name, email, password } = body as { name?: string; email?: string; password?: string };

  if (!name || !email || !password) {
    return NextResponse.json({ error: 'name, email and password are required' }, { status: 400 });
  }

  // Enable signup temporarily for this call — the emailAndPasswordConfig getter reads this at call time
  process.env.ONBOARDING = 'true';

  let baResponse: Response;
  try {
    baResponse = await auth.api.signUpEmail({
      body: { name, email, password },
      headers: req.headers,
      asResponse: true,
    }) as Response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Sign-up failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!baResponse.ok) {
    const data = await baResponse.json().catch(() => ({}));
    return NextResponse.json({ error: (data as { message?: string }).message || 'Sign-up failed' }, { status: 400 });
  }

  const signUpData = await baResponse.json() as { user: { id: string; email: string } };

  // Promote to admin
  await db
    .update(user)
    .set({ role: 'admin', updatedAt: new Date() })
    .where(eq(user.email, email.trim().toLowerCase()));

  // Log onboarding completion
  await markOnboardingComplete({
    completedBy: signUpData.user.id,
    method: 'ui',
    notes: email,
  });

  // Forward Set-Cookie from better-auth so the browser gets the session
  const result = NextResponse.json({ success: true });
  baResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      result.headers.append('set-cookie', value);
    }
  });
  return result;
}
