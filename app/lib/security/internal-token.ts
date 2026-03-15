import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';

import { resolveSkillsTokenPath } from '@/app/lib/runtime-data-paths';

function tokenDigest(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

export async function resolveInternalToken(): Promise<string> {
  const envToken = process.env.CANVAS_SKILLS_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  try {
    const fileToken = (await fs.readFile(resolveSkillsTokenPath(), 'utf8')).trim();
    return fileToken;
  } catch {
    return '';
  }
}

export async function isValidInternalToken(candidateToken: string | null | undefined): Promise<boolean> {
  if (!candidateToken) {
    return false;
  }

  const expectedToken = await resolveInternalToken();
  if (!expectedToken) {
    return false;
  }

  const candidateDigest = tokenDigest(candidateToken);
  const expectedDigest = tokenDigest(expectedToken);
  return crypto.timingSafeEqual(candidateDigest, expectedDigest);
}
