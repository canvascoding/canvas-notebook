import { APIError, betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { db } from "@/app/lib/db";
import { getDatabaseProvider } from "@/app/lib/db/provider";
import { user } from "@/app/lib/db/schema";
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
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (
        context.path === "/admin/create-user"
        && (context.request || context.headers)
      ) {
        throw APIError.from("FORBIDDEN", {
          code: "MEMBERSHIP_ORCHESTRATOR_REQUIRED",
          message: "Create users through the server-side membership orchestrator.",
        });
      }
    }),
  },
  plugins: [
    admin(),
    bearer(),
    expo(),
    nextCookies(),
  ],
  session: {
    cookieCache: {
      // License downgrade, offboarding and security revocation delete sessions
      // in the database. A client-side session cache would keep those sessions
      // usable until the cache expires, so authorization stays database-backed.
      enabled: false,
    }
  },
  advanced: {
    defaultCookieAttributes: {
      secure: useSecureCookies,
      sameSite: "lax",
    }
  },
});

export const PENDING_TEAM_MEMBERSHIP_BAN_REASON = "canvas_team_membership_pending";

export class MembershipIdentityError extends Error {
  constructor(
    public readonly code:
      | "MEMBERSHIP_IDENTITY_CONFLICT"
      | "MEMBERSHIP_IDENTITY_CREATE_FAILED"
      | "MEMBERSHIP_IDENTITY_ACTIVATION_DENIED",
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "MembershipIdentityError";
  }
}

type MembershipIdentity = {
  id: string;
  email: string;
  banned: boolean;
  banReason: string | null;
};

async function findMembershipIdentity(email: string): Promise<MembershipIdentity | null> {
  const normalizedEmail = email.trim().toLowerCase();
  const rows = await db.select({
    id: user.id,
    email: user.email,
    banned: user.banned,
    banReason: user.banReason,
  }).from(user).where(eq(user.email, normalizedEmail)).limit(1);
  const existing = rows[0];
  return existing
    ? {
        id: existing.id,
        email: existing.email,
        banned: existing.banned === true,
        banReason: existing.banReason ?? null,
      }
    : null;
}

export async function assertTeamMembershipIdentityAvailable(
  email: string,
  expectedUserId?: string | null,
): Promise<void> {
  const existing = await findMembershipIdentity(email);
  if (existing?.id === expectedUserId) return;
  if (
    existing
    && (!existing.banned || existing.banReason !== PENDING_TEAM_MEMBERSHIP_BAN_REASON)
  ) {
    throw new MembershipIdentityError(
      "MEMBERSHIP_IDENTITY_CONFLICT",
      "An unrelated Better Auth user already uses this email address.",
    );
  }
}

export async function ensurePendingTeamMembershipIdentity(input: {
  name: string;
  email: string;
  password: string;
  role: "admin" | "user";
}): Promise<MembershipIdentity> {
  const email = input.email.trim().toLowerCase();
  const existing = await findMembershipIdentity(email);
  if (existing) {
    if (existing.banned && existing.banReason === PENDING_TEAM_MEMBERSHIP_BAN_REASON) {
      try {
        await auth.api.setUserPassword({
          body: {
            userId: existing.id,
            newPassword: input.password,
          },
        });
      } catch (error) {
        throw new MembershipIdentityError(
          "MEMBERSHIP_IDENTITY_CREATE_FAILED",
          error instanceof Error ? error.message : "Could not update the pending Better Auth password.",
          500,
        );
      }
      return existing;
    }
    throw new MembershipIdentityError(
      "MEMBERSHIP_IDENTITY_CONFLICT",
      "An unrelated Better Auth user already uses this email address.",
    );
  }

  let created;
  try {
    created = await auth.api.createUser({
      body: {
        name: input.name.trim(),
        email,
        password: input.password,
        role: input.role,
        data: {
          banned: true,
          banReason: PENDING_TEAM_MEMBERSHIP_BAN_REASON,
          banExpires: null,
        },
      },
    });
  } catch (error) {
    const recovered = await findMembershipIdentity(email);
    if (recovered?.banned && recovered.banReason === PENDING_TEAM_MEMBERSHIP_BAN_REASON) {
      return recovered;
    }
    throw new MembershipIdentityError(
      "MEMBERSHIP_IDENTITY_CREATE_FAILED",
      error instanceof Error ? error.message : "Could not create the pending Better Auth user.",
      500,
    );
  }

  const identity = await findMembershipIdentity(created.user.email);
  if (!identity?.banned || identity.banReason !== PENDING_TEAM_MEMBERSHIP_BAN_REASON) {
    throw new MembershipIdentityError(
      "MEMBERSHIP_IDENTITY_CREATE_FAILED",
      "The Better Auth user was not created in a safe pending state.",
      500,
    );
  }
  return identity;
}

export async function activatePendingTeamMembershipIdentity(userId: string): Promise<void> {
  const rows = await db.select({
    id: user.id,
    banned: user.banned,
    banReason: user.banReason,
  }).from(user).where(eq(user.id, userId)).limit(1);
  const identity = rows[0];
  if (!identity) {
    throw new MembershipIdentityError(
      "MEMBERSHIP_IDENTITY_CONFLICT",
      "The pending Better Auth user no longer exists.",
      404,
    );
  }
  if (identity.banned !== true) return;
  if (identity.banReason !== PENDING_TEAM_MEMBERSHIP_BAN_REASON) {
    throw new MembershipIdentityError(
      "MEMBERSHIP_IDENTITY_ACTIVATION_DENIED",
      "A security-managed Better Auth ban cannot be cleared by membership activation.",
    );
  }
  await db.update(user).set({
    banned: false,
    banReason: null,
    banExpires: null,
    updatedAt: new Date(),
  }).where(eq(user.id, userId));
}
