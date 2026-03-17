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

  let signUpResult: Awaited<ReturnType<typeof auth.api.signUpEmail>>;
  try {
    signUpResult = await auth.api.signUpEmail({
      body: { name, email, password },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Sign-up failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Promote to admin
  await db
    .update(user)
    .set({ role: 'admin', updatedAt: new Date() })
    .where(eq(user.email, email.trim().toLowerCase()));

  // Log onboarding completion
  await markOnboardingComplete({
    completedBy: signUpResult.user.id,
    method: 'ui',
    notes: email,
  });

  return NextResponse.json({ success: true });
}
