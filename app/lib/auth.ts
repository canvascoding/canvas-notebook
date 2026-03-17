import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/app/lib/db";
import { nextCookies } from "better-auth/next-js";

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

// Use a getter so disableSignUp is evaluated at request time, not at module init.
// This allows the onboarding setup route to temporarily enable signup by setting
// process.env.ONBOARDING = 'true' before calling auth.api.signUpEmail.
const emailAndPasswordConfig = {
  enabled: true,
  get disableSignUp() {
    return process.env.ONBOARDING !== 'true';
  },
};

export const auth = betterAuth({
  secret: authSecret,
  baseURL: authBaseURL,
  database: drizzleAdapter(db, {
    provider: "sqlite",
  }),
  emailAndPassword: emailAndPasswordConfig,
  plugins: [
    nextCookies(),
  ],
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "user",
      }
    }
  },
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
