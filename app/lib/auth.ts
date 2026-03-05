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
const allowSignUp = process.env.ALLOW_SIGNUP === "true";
const forceSecureCookies = process.env.AUTH_COOKIE_SECURE === "true";
const useSecureCookies =
  forceSecureCookies || Boolean(authBaseURL && authBaseURL.startsWith("https://"));

export const auth = betterAuth({
  secret: authSecret,
  baseURL: authBaseURL,
  database: drizzleAdapter(db, {
    provider: "sqlite",
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: !allowSignUp,
  },
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
  // hooks: {
  //   before: async (ctx: any) => { // Cast ctx to any
  //     if ((ctx.req as NextRequest).nextUrl.pathname === "/sign-up/email") { // Cast ctx.req to NextRequest
  //       throw new Error("Sign up is disabled");
  //     }
  //   }
  // }
});
