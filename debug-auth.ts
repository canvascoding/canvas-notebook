
import { config } from 'dotenv';
config({ path: '.env.local' });

import { auth } from './app/lib/auth';

async function testLogin() {
  console.log('Attempting login...');
  try {
    const res = await auth.api.signInEmail({
        body: {
            email: "admin.com",
            password: "change-me"
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
