import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/app/lib/db";
import { nextCookies } from "better-auth/next-js";

const authBaseURL =
  process.env.BETTER_AUTH_BASE_URL ||
  process.env.BASE_URL;
const allowSignUp = process.env.ALLOW_SIGNUP === "true";

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
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
      secure: process.env.NODE_ENV === "production",
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
