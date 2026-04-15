import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/app/lib/db";
import { nextCookies } from "better-auth/next-js";
import { bearer } from "better-auth/plugins";
import { BOOTSTRAP_SIGNUP_ENV } from "@/app/lib/bootstrap-admin";

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
  get disableSignUp() {
    return process.env[BOOTSTRAP_SIGNUP_ENV] !== 'true';
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
    bearer(),
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
