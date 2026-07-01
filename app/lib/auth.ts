import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/app/lib/db";
import { getDatabaseProvider } from "@/app/lib/db/provider";
import { nextCookies } from "better-auth/next-js";
import { admin, bearer } from "better-auth/plugins";

const authBaseURL =
  process.env.BETTER_AUTH_BASE_URL ||
  process.env.BASE_URL;
const authSecret =
  process.env.BETTER_AUTH_SECRET ||
  process.env.AUTH_SECRET ||
  "canvas-notebook-local-dev-secret-change-me";
const forceSecureCookies = process.env.AUTH_COOKIE_SECURE === "true";
const useSecureCookies =
  forceSecureCookies || Boolean(authBaseURL && authBaseURL.startsWith("https://"));

const emailAndPasswordConfig = {
  enabled: true,
  disableSignUp: true,
};

const trustedOrigins = [
  authBaseURL,
  ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS
    ? process.env.BETTER_AUTH_TRUSTED_ORIGINS.split(',').map(o => o.trim())
    : []),
].filter(Boolean) as string[];

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
