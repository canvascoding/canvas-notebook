import { loadAppEnv } from './server/load-app-env';
loadAppEnv(process.cwd());

import { auth } from './app/lib/auth';

const email = process.env.DEBUG_AUTH_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const password = process.env.DEBUG_AUTH_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

async function testLogin() {
  console.log('Attempting login...');
  try {
    const res = await auth.api.signInEmail({
        body: {
            email,
            password
        }
    });
    console.log('Login result:', res);
  } catch (error: unknown) {
    console.error('Login error details:', error);
    if (error && typeof error === 'object' && 'cause' in error) {
        console.error('Cause:', (error as { cause?: unknown }).cause);
    }
    if (error && typeof error === 'object' && 'stack' in error) {
        console.error('Stack:', (error as { stack?: unknown }).stack);
    }
  }
}

testLogin();
