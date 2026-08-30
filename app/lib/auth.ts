import { APIError, betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { db } from "@/app/lib/db";
import { getDatabaseProvider } from "@/app/lib/db/provider";
import { session as authSession, user } from "@/app/lib/db/schema";
import { nextCookies } from "better-auth/next-js";
import { admin, bearer, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { expo } from '@better-auth/expo';
import { resolveAuthSecret } from '@/app/lib/security/auth-secret';
import { getConfiguredTrustedOrigins } from '@/app/lib/security/trusted-origins';
import {
  isTeamMembershipReactivationBanReason,
} from '@/app/lib/organization/membership-ban-reasons';
import {
  DIRECT_MCP_OAUTH_SCOPES,
  resolveDirectMcpOAuthConfig,
} from '@/app/lib/mcp/server/config';
import { recordDirectMcpOAuthProviderError } from '@/app/lib/mcp/server/diagnostics';
import {
  assertUserSeatAccess,
  SeatLimitGuardError,
} from '@/app/lib/license/seat-limit';

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
// Keep the OAuth provider prepared even while the Canvas MCP server is
// disabled. The MCP routes enforce the feature flag, so enabling it from
// Settings does not require recreating Better Auth and restarting Canvas.
let directMcpConfig: ReturnType<typeof resolveDirectMcpOAuthConfig> | null = null;
try {
  directMcpConfig = resolveDirectMcpOAuthConfig();
} catch (error) {
  // Instances without a valid public URL cannot expose a remote MCP server.
  // Preserve the normal Canvas login flow and surface the configuration error
  // in the MCP settings instead of preventing the app from starting.
  console.warn('[Auth] Direct MCP OAuth provider is not prepared:', error);
}

const directMcpOAuthPlugins = directMcpConfig
  ? [
      jwt({
        jwt: {
          issuer: directMcpConfig.issuer,
        },
      }),
      oauthProvider({
        loginPage: "/login",
        consentPage: "/oauth/consent",
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        allowPublicClientPrelogin: false,
        grantTypes: ["authorization_code", "refresh_token"],
        scopes: [...DIRECT_MCP_OAUTH_SCOPES],
        clientRegistrationDefaultScopes: ["openid"],
        clientRegistrationAllowedScopes: [...DIRECT_MCP_OAUTH_SCOPES],
        resources: [{
          identifier: directMcpConfig.resource,
          name: 'Canvas Notebook MCP',
          allowedScopes: [...DIRECT_MCP_OAUTH_SCOPES],
        }],
        clientRegistrationDefaultResources: [directMcpConfig.resource],
        clientRegistrationAllowedResources: [directMcpConfig.resource],
        validAudiences: [directMcpConfig.resource],
        codeExpiresIn: 5 * 60,
        accessTokenExpiresIn: 15 * 60,
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
        storeClientSecret: "hashed",
        storeTokens: "hashed",
        clientPrivileges: () => false,
        rateLimit: {
          token: { window: 60, max: 20 },
          authorize: { window: 60, max: 30 },
          introspect: { window: 60, max: 100 },
          revoke: { window: 60, max: 30 },
          register: { window: 60, max: 5 },
          userinfo: { window: 60, max: 60 },
        },
        silenceWarnings: {
          oauthAuthServerConfig: true,
        },
      }),
    ]
  : [];

async function revokeSeatGuardSessions(userId: string): Promise<void> {
  await db.delete(authSession).where(eq(authSession.userId, userId));
}

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
      if (
        (context.path === "/admin/ban-user" || context.path === "/admin/unban-user")
        && (context.request || context.headers)
      ) {
        throw APIError.from("FORBIDDEN", {
          code: "MEMBERSHIP_ORCHESTRATOR_REQUIRED",
          message: "Suspend or reactivate users through the server-side membership orchestrator.",
        });
      }
    }),
    after: createAuthMiddleware(async (context) => {
      const seatSession = context.context.newSession
        ?? (context.path === "/get-session" ? context.context.session : null);
      if (!seatSession) return;
      try {
        await assertUserSeatAccess({ userId: seatSession.user.id });
      } catch (error) {
        if (!(error instanceof SeatLimitGuardError)) throw error;
        await revokeSeatGuardSessions(seatSession.user.id);
        context.context.setNewSession(null);
        if (context.path === "/get-session") {
          return context.json(null);
        }
        throw APIError.from("FORBIDDEN", {
          code: error.code,
          message: error.message,
        });
      }
    }),
  },
  plugins: [
    admin(),
    bearer(),
    expo(),
    ...directMcpOAuthPlugins,
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
  onAPIError: {
    onError(error) {
      if (recordDirectMcpOAuthProviderError(error)) return;
      // Do not expose an upstream error body in shared logs. Direct MCP errors
      // are correlated above; other Better Auth errors retain a safe signal.
      console.error('[auth] Better Auth API request failed.');
    },
  },
  advanced: {
    // The public origin is configured explicitly. Never let a client-supplied
    // forwarded host/proto alter OAuth issuer or endpoint URLs.
    trustedProxyHeaders: false,
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

export async function assertTeamMembershipIdentityReactivatable(
  userId: string,
  email: string,
): Promise<void> {
  const existing = await findMembershipIdentity(email);
  if (
    !existing
    || existing.id !== userId
    || !existing.banned
    || !isTeamMembershipReactivationBanReason(existing.banReason)
  ) {
    throw new MembershipIdentityError(
      "MEMBERSHIP_IDENTITY_ACTIVATION_DENIED",
      "Only an account suspended by the Team membership orchestrator can be reactivated.",
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
  if (
    identity.banReason !== PENDING_TEAM_MEMBERSHIP_BAN_REASON
    && !isTeamMembershipReactivationBanReason(identity.banReason)
  ) {
    throw new MembershipIdentityError(
      "MEMBERSHIP_IDENTITY_ACTIVATION_DENIED",
      "A security-managed or offboarding ban cannot be cleared by membership activation.",
    );
  }
  await db.update(user).set({
    banned: false,
    banReason: null,
    banExpires: null,
    updatedAt: new Date(),
  }).where(eq(user.id, userId));
}
