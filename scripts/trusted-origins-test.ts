import assert from 'node:assert/strict';

import {
  getConfiguredTrustedOrigins,
  isConfiguredTrustedOrigin,
} from '../app/lib/security/trusted-origins';

const keys = [
  'BASE_URL',
  'BETTER_AUTH_BASE_URL',
  'BETTER_AUTH_TRUSTED_ORIGINS',
  'NODE_ENV',
  'PORT',
] as const;
const original = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));

try {
  (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
  process.env.BASE_URL = 'https://canvas.example.com/app';
  process.env.BETTER_AUTH_BASE_URL = 'https://auth.canvas.example.com';
  process.env.BETTER_AUTH_TRUSTED_ORIGINS = 'https://admin.canvas.example.com, not a URL';

  assert.deepEqual(
    getConfiguredTrustedOrigins().sort(),
    [
      'https://admin.canvas.example.com',
      'https://auth.canvas.example.com',
      'https://canvas.example.com',
    ],
  );
  assert.equal(isConfiguredTrustedOrigin('https://canvas.example.com'), true);
  assert.equal(isConfiguredTrustedOrigin('https://admin.canvas.example.com/path'), true);
  assert.equal(isConfiguredTrustedOrigin('https://attacker.example.com'), false);
  assert.equal(isConfiguredTrustedOrigin(undefined), false);

  delete process.env.BASE_URL;
  delete process.env.BETTER_AUTH_BASE_URL;
  delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
  process.env.PORT = '3000';

  assert.equal(isConfiguredTrustedOrigin('http://localhost:3000'), true);
  assert.equal(isConfiguredTrustedOrigin('http://127.0.0.1:3000'), true);
  assert.equal(isConfiguredTrustedOrigin('http://localhost:3001'), false);
} finally {
  for (const [key, value] of original) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

console.log('trusted-origins-test: ok');
