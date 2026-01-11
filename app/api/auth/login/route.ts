import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/app/lib/auth/session';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { compare } from 'bcryptjs';

// Load credentials from environment variables
const ADMIN_USERNAME = process.env.APP_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = process.env.APP_PASSWORD_HASH;
const ADMIN_PASSWORD_PLAIN = process.env.APP_PASSWORD;

if (!ADMIN_PASSWORD_HASH && !ADMIN_PASSWORD_PLAIN) {
  console.warn('[Security Warning] No APP_PASSWORD_HASH or APP_PASSWORD set in .env.local');
}

export async function POST(request: NextRequest) {
  try {
    const limited = rateLimit(request, {
      limit: 5, // Reduced from 10 for better security
      windowMs: 60_000,
      keyPrefix: 'auth-login',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const body = await request.json();
    const { username, password } = body;

    // Simple validation
    if (!username || !password) {
      return NextResponse.json(
        { success: false, error: 'Username and password are required' },
        { status: 400 }
      );
    }

    // Check username
    if (username !== ADMIN_USERNAME) {
      // Add artificial delay to prevent timing attacks
      await new Promise(resolve => setTimeout(resolve, 1000));
      return NextResponse.json(
        { success: false, error: 'Invalid credentials' },
        { status: 401 }
      );
    }

    // Check password (prefer hash, fallback to plain)
    let isValidPassword = false;

    if (ADMIN_PASSWORD_HASH) {
      // Use bcrypt for hashed passwords
      isValidPassword = await compare(password, ADMIN_PASSWORD_HASH);
    } else if (ADMIN_PASSWORD_PLAIN) {
      // Fallback to plain text comparison (less secure, but works)
      isValidPassword = password === ADMIN_PASSWORD_PLAIN;
      console.warn('[Security Warning] Using plain text password. Consider using APP_PASSWORD_HASH instead.');
    }

    if (isValidPassword) {
      const session = await getSession();
      session.username = username;
      session.isLoggedIn = true;
      await session.save();

      return NextResponse.json({ success: true });
    }

    // Add artificial delay to prevent timing attacks
    await new Promise(resolve => setTimeout(resolve, 1000));

    return NextResponse.json(
      { success: false, error: 'Invalid credentials' },
      { status: 401 }
    );
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
