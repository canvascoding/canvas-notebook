/* eslint-disable @typescript-eslint/no-require-imports */
const { unsealData } = require('iron-session');

const COOKIE_NAME = 'canvas-notebook-session';
const DEFAULT_SECRET =
  'change_this_to_a_random_32_character_secret_key_in_production';
const SESSION_TTL = 60 * 60 * 24 * 7;

function parseCookies(header) {
  if (!header) return {};
  return header.split(';').reduce((acc, part) => {
    const trimmed = part.trim();
    if (!trimmed) return acc;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return acc;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

async function getSessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const seal = cookies[COOKIE_NAME];
  if (!seal) return null;

  try {
    const session = await unsealData(seal, {
      password: process.env.SESSION_SECRET || DEFAULT_SECRET,
      ttl: SESSION_TTL,
    });
    return session || null;
  } catch {
    return null;
  }
}

module.exports = {
  getSessionFromRequest,
};
