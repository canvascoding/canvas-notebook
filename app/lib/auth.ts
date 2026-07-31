import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/app/lib/db";
import { getDatabaseProvider } from "@/app/lib/db/provider";
import { nextCookies } from "better-auth/next-js";
import { admin, bearer } from "better-auth/plugins";
import { expo } from '@better-auth/expo';
import { resolveAuthSecret } from '@/app/lib/security/auth-secret';
import { getConfiguredTrustedOrigins } from '@/app/lib/security/trusted-origins';

const authBaseURL =
  process.env.BETTER_AUTH_BASE_URL ||
  process.env.BASE_URL;
const authSecret = resolveAuthSecret(process.env, {
  allowProductionBuildFallback: true,
});
const forceSecureCookies = process.env.AUTH_COOKIE_SECURE === "true";
const useSecureCookies =
  forceSecureCookies || Boolean(authBaseURL && authBaseURL.startsWith("https://"));

const emailAndPasswordConfig = {
  enabled: true,
  disableSignUp: true,
};

const trustedOrigins = getConfiguredTrustedOrigins();

export const auth = betterAuth({
  secret: authSecret,
  baseURL: authBaseURL,
  trustedOrigins,
  database: drizzleAdapter(db, {
    provider: getDatabaseProvider() === "postgres" ? "pg" : "sqlite",
  }),
  emailAndPassword: emailAndPasswordConfig,
  plugins: [
    admin(),
    bearer(),
    expo(),
    nextCookies(),
  ],
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes cache
    }
  },
  advanced: {
    defaultCookieAttributes: {
      secure: useSecureCookies,
      sameSite: "lax",
    }
  },
});
