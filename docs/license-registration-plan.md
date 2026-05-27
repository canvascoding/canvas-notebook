# License & Registration Plan — Canvas Notebook

> Date: 2026-05-19
> Status: Draft

## 1. Goals

1. **Community Registration**: Self-hosted users register their email → get a free community license key → unlock community-tier features.
2. **Managed Auto-License**: When a notebook instance is provisioned via the Control Plane, it automatically receives a managed license (no registration needed).
3. **Future Pro Tier**: The architecture must support a future "Pro" self-hosted tier with more features, purchasable independently from the Control Plane.
4. **Usage Tracking**: Know how many users/instances are running (community + managed).

## 2. License Tiers

| Tier | How obtained | Features | Cost |
|---|---|---|---|
| **Unregistered** | Default (no valid license certificate) | Setup, auth, and license activation screen only; main app locked | Free |
| **Community** | Email registration on the instance | All community-tier features (folders, advanced debug, search, etc.) | Free |
| **Pro** (future) | Purchase a license key from canvasstudios.io | All community features + pro-only features (TBD) | Paid |
| **Managed** | Auto-provisioned by Control Plane | Full feature set, managed by control plane | Included with Control Plane |

## 3. Current Managed Infrastructure

The Control Plane already provisions managed notebook instances with these env vars:

```bash
CANVAS_MANAGED_SERVICES_ENABLED=true
CANVAS_CONTROL_PLANE_URL=https://control.example.com
CANVAS_INSTANCE_ID=vm_abc123
CANVAS_INSTANCE_TOKEN=ms_xxx...
```

These are set by `applyManagedEnvToVmConfig()` / `ensureManagedEnvForVmConfig()` in the Control Plane (`apps/api/src/services/managedSecrets.ts`).

The notebook already detects managed mode via `isCanvasControlPlaneManagedAvailable()`:

```ts
// app/lib/pi/model-resolver.ts:93
export function isCanvasControlPlaneManagedAvailable(): boolean {
  return (
    process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' ||
    Boolean(process.env.CANVAS_CONTROL_PLANE_URL?.trim() && process.env.CANVAS_INSTANCE_TOKEN?.trim())
  );
}
```

**Key insight**: If `CANVAS_INSTANCE_ID` and `CANVAS_INSTANCE_TOKEN` are present, the instance is managed by a Control Plane and should automatically get a managed license — no registration step needed.

## 4. Architecture

```
┌──────────────────────────────────────────┐      ┌─────────────────────────────┐
│  Canvas Notebook (Container)             │      │  Canvas Control Plane       │
│                                          │      │                             │
│  ┌──────────────────────────────────┐    │      │  /v1/license/register      │
│  │  LicenseManager                  │    │      │  /v1/license/activate      │
│  │  - loadCert() from SQLite       │    │      │  /v1/license/verify        │
│  │  - isLicensed(feature)           │    │      │  /v1/license/refresh       │
│  │  - getPlan() → tier name        │    │      │                             │
│  │  - activate(key)                │────┼──────▶  PostgreSQL                 │
│  │  - register(email)              │────┼──────▶    licenses table           │
│  │  - refresh() (periodic)         │────┼──────▶    vm_agents → license_id   │
│  └──────────────────────────────────┘    │      │                             │
│                                          │      │  RSA Private Key            │
│  Detection on startup:                   │      │  Email (nodemailer)         │
│  ┌──────────────────────────────────┐    │      └─────────────────────────────┘
│  │ if CANVAS_LICENSE_CERT env var:  │    │
│  │   → use pre-provisioned license  │    │      ┌─────────────────────────────┐
│  │ elif CANVAS_INSTANCE_ID present: │    │      │  Email Provider             │
│  │   → fetch managed license        │    │      │  (Resend/SendGrid/etc.)    │
│  │ elif cert in SQLite:            │    │      │                             │
│  │   → use stored license           │    │      │  Sends license key email   │
│  │ else:                            │    │      └─────────────────────────────┘
│  │   → unregistered (app locked)    │    │
│  └──────────────────────────────────┘    │
│                                          │
│  Feature Gating:                        │
│  ┌──────────────────────────────────┐    │
│  │  <LicenseGate feature="folders">│    │
│  │    <FoldersUI />                │    │
│  │    <LicenseGate.Fallback>       │    │
│  │      <UpgradePrompt />          │    │
│  │    </LicenseGate.Fallback>      │    │
│  │  </LicenseGate>                 │    │
│  └──────────────────────────────────┘    │
└──────────────────────────────────────────┘
```

## 5. License JWT Payload

The license is a JWT signed with RSA (private key on Control Plane, public key embedded in notebook).

```ts
interface LicenseCert {
  sub: string;           // Instance ID (CANVAS_INSTANCE_ID or auto-generated UUID)
  plan: 'unregistered' | 'community' | 'pro' | 'managed';
  features: Record<string, boolean>;  // e.g., { folders: true, advancedDebug: true }
  quotas: Record<string, number>;      // e.g., { maxTeamMembers: 5 }
  iss: 'canvas-control-plane';
  iat: number;
  exp: number;           // Community: 365 days, Pro: per subscription, Managed: 90 days (auto-renewed)
}
```

### Feature Constants

```ts
// app/lib/license/features.ts
export const LICENSE_FEATURES = {
  // Community-tier features (free with registration)
  FOLDERS: 'folders',
  ADVANCED_DEBUG: 'advancedDebug',
  EXECUTION_SEARCH: 'executionSearch',
  EXECUTION_TAGGING: 'executionTagging',
  SHARED_CREDENTIALS: 'sharedCredentials',
  SOURCE_CONTROL: 'sourceControl',
  DYNAMIC_CREDENTIALS: 'dynamicCredentials',

  // Pro-tier features (future, paid self-hosted)
  LDAP: 'ldap',
  SAML: 'saml',
  OIDC: 'oidc',
  LOG_STREAMING: 'logStreaming',
  ADVANCED_PERMISSIONS: 'advancedPermissions',

  // Managed features (Control Plane only)
  MANAGED_AI_PROVIDER: 'managedAiProvider',
  MANAGED_SECRETS: 'managedSecrets',
  MANAGED_MONITORING: 'managedMonitoring',
} as const;

export const LICENSE_QUOTAS = {
  MAX_TEAM_MEMBERS: 'maxTeamMembers',
  MAX_NOTEBOOKS: 'maxNotebooks',
  MAX_EXECUTIONS_PER_MONTH: 'maxExecutionsPerMonth',
} as const;
```

> **Note**: The actual feature list is TBD. The above are placeholders based on what n8n gates and what makes sense for Canvas Notebook. The exact features will be determined as they are implemented.

## 6. License Detection Flow (Notebook App)

On startup, the `LicenseManager` determines the license tier:

```ts
async init() {
  // 1. Check if CANVAS_LICENSE_CERT env var is set (managed, pre-provisioned)
  if (process.env.CANVAS_LICENSE_CERT) {
    const verified = this.verifyJWT(process.env.CANVAS_LICENSE_CERT);
    if (verified) {
      this.cert = verified;
      await this.saveCertToDB(process.env.CANVAS_LICENSE_CERT);
      this.scheduleRefresh();
      return;
    }
  }

  // 2. If managed (has CANVAS_INSTANCE_ID + CANVAS_INSTANCE_TOKEN),
  //    try fetching managed license from Control Plane
  if (isCanvasControlPlaneManagedAvailable()) {
    await this.fetchManagedLicense();
    if (this.cert) {
      this.scheduleRefresh();
      return;
    }
  }

  // 3. Try to load license cert from SQLite DB
  const stored = await this.loadCertFromDB();
  if (stored) {
    const verified = this.verifyJWT(stored);
    if (verified && !this.isExpired(verified)) {
      this.cert = verified;
      this.scheduleRefresh();
      return;
    }
    // Expired but still valid structure → try refresh via Control Plane
    if (verified) {
      await this.refresh();
      return;
    }
  }

  // 4. No valid license → unregistered
  this.cert = null;
}
```

### Managed License Auto-Fetch

```ts
async fetchManagedLicense() {
  const instanceId = process.env.CANVAS_INSTANCE_ID!;
  const token = process.env.CANVAS_INSTANCE_TOKEN!;
  const controlPlaneUrl = getManagedControlPlaneBaseUrl()!;

  const response = await fetch(`${controlPlaneUrl}/v1/license/managed`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Instance-ID': instanceId,
    },
  });

  if (response.ok) {
    const { license } = await response.json();
    const verified = this.verifyJWT(license);
    if (verified) {
      this.cert = verified;
      await this.saveCertToDB(license);
    }
  }
  // Fallback: if Control Plane is unreachable, try to use cached cert from DB
  if (!this.cert) {
    const cached = await this.loadCertFromDB();
    if (cached) this.cert = this.verifyJWT(cached);
  }
}
```

## 7. Registration Flow (Community Tier)

### 7.1 Frontend Flow

```
Setup Wizard (Language → Provider → Done)
  ↓
markOnboardingComplete()
  ↓
if (licenseManager.getPlan() === 'unregistered') {
  showCommunityRegistrationModal()
}
  ↓
CommunityRegistrationModal
  ├─ Email input (pre-filled with bootstrap admin email)
  └─ "Send me a free license key" button
      ↓
  POST /api/license/register { email }
      ↓
  Backend validates email, then either:
    a) Calls Control Plane: POST https://control-plane/v1/license/register { email, instanceId }
    b) OR generates key locally if no Control Plane URL is configured
      ↓
  Control Plane generates key, sends email, returns { title, text }
      ↓
  Frontend shows toast: "License key sent to {email}"
      ↓
  User clicks link in email: https://<instance>/settings/license?key=<key>
      ↓
  GET /settings/license?key=<key>
      ↓
  POST /api/license/activate { key }
      ↓
  Backend validates key, generates signed JWT, returns license info
      ↓
  Backend stores JWT in SQLite, returns license info
      ↓
  Frontend updates license store, all community features unlocked
```

### 7.2 Where Registration Prompt Appears

| Trigger | Component | Condition |
|---|---|---|
| After onboarding | License activation screen | `plan === 'unregistered'` |
| Settings page | `SettingsLicense` page | Always visible (manage license) |
| App/API guard | `LicenseRequired` / route guard | Any main app access while `plan === 'unregistered'` |

### 7.3 Alternative: Direct Activation

For users who already have a license key (e.g., from a Pro purchase):

```
Settings → License → "Add activation key"
  ↓
POST /api/license/activate { key }
```

## 8. Control Plane Changes

### 8.1 New Endpoints (`apps/api/src/routes/license.ts`)

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `POST /v1/license/register` | Public (rate-limited) | None | Email → generate key → send email → return `{ title, text }` |
| `POST /v1/license/activate` | Public | None | Validate key → generate JWT → return `{ license, plan, features }` |
| `GET /v1/license/verify/:instanceId` | Instance Token (ms_*) | Bearer | Verify a license is still valid → return refreshed JWT |
| `POST /v1/license/refresh` | Instance Token (ms_*) | Bearer | Refresh an expiring JWT |
| `GET /v1/license/managed` | Instance Token (ms_*) | Bearer | Auto-provision a managed license for a VM |

### 8.2 New DB Table (`apps/api/src/db/schema.ts`)

```ts
export const licenses = pgTable('licenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull(),
  license_key: varchar('license_key', { length: 255 }).notNil().unique(),
  plan: varchar('plan', { length: 50 }).notNull().default('community'),
  // 'community' | 'pro' | 'managed'
  features: jsonb('features').notDeleted().default({}),
  // { folders: true, advancedDebug: true, ... }
  quotas: jsonb('quotas').notDeleted().default({}),
  // { maxTeamMembers: 5, ... }
  activated: boolean('activated').default(false),
  instance_id: varchar('instance_id', { length: 255 }),
  // Links to CANVAS_INSTANCE_ID or null if not yet activated
  activated_at: timestamp('activated_at'),
  expires_at: timestamp('expires_at'),
  // null = unlimited for community; set for pro
  created_at: timestamp('created_at').defaultNow(),
  updated_at: timestamp('updated_at').defaultNow(),
});
```

### 8.3 VM Table Extension

Add to existing `vm_agents` table:

```ts
license_id: varchar('license_id', { length: 255 }),
// FK to licenses table for managed instances
license_status: varchar('license_status', { length: 50 }).default('active'),
// 'active' | 'expired' | 'unregistered'
```

### 8.4 Managed License Auto-Provisioning

When the Control Plane provisions a VM's managed env vars (in `ensureManagedEnvForVmConfig()`), it should also:

1. Auto-create a managed license for the VM in the `licenses` table
2. Sign a JWT with the VM's `instanceId` and all managed features
3. Include the license JWT in the env vars: `CANVAS_LICENSE_CERT=<jwt>`

```ts
// In ensureManagedEnvForVmConfig():
const managedLicense = await createManagedLicense(vmId);
env['CANVAS_LICENSE_CERT'] = managedLicense.jwt;
```

**Recommendation**: Use `CANVAS_LICENSE_CERT` env var for managed instances (immediate license, no network dependency at boot), with background refresh via `GET /v1/license/managed` for renewal.

### 8.5 RSA Key Management

- Generate an RSA 4096-bit key pair (`scripts/generate-keys.sh`)
- Private key: Stays on the Control Plane server only (signing JWTs)
- Public key: Distributed to notebook apps via:
  - Embedded in the app at build time (`app/lib/license/public-key.pem`)
  - Overridable via env var `CANVAS_LICENSE_PUBLIC_KEY` (for key rotation without rebuild)
- Key rotation: New key pair → sign new JWTs with new key → accept both public keys during transition → remove old public key after all JWTs expire

## 9. Notebook App Changes

### 9.1 New Files

| File | Purpose |
|---|---|
| `app/lib/license/index.ts` | LicenseManager class (load, verify, refresh, activate, register) |
| `app/lib/license/features.ts` | LICENSE_FEATURES and LICENSE_QUOTAS constants |
| `app/lib/license/jwt.ts` | JWT verification with RSA public key |
| `app/lib/license/storage.ts` | License cert persistence in SQLite |
| `app/lib/license/route-guards.ts` | API route guard (requireLicense) |
| `app/lib/license-store.ts` | Zustand store for frontend license state |
| `app/api/license/register/route.ts` | POST: email registration |
| `app/api/license/activate/route.ts` | POST: activate license key, store JWT |
| `app/api/license/status/route.ts` | GET: current license info for frontend |
| `app/components/license/LicenseActivationPanel.tsx` | Locked activation UI (email request + key activation) |
| `app/components/license/LicenseRequired.tsx` | Page-level lock screen wrapper |
| `app/components/license/LicenseGate.tsx` | Future per-feature gate component (children + fallback) |
| `app/components/license/UpgradePrompt.tsx` | Future "Upgrade to unlock this feature" card |
| `app/[locale]/(routes)/settings/license/page.tsx` | License management settings page |

### 9.2 DB Schema Changes (`app/lib/db/schema.ts`)

```ts
export const license_certs = sqliteTable('license_certs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  cert: text('cert').notNull(),         // The full JWT string
  plan: text('plan').notNull(),          // 'community' | 'pro' | 'managed'
  instance_id: text('instance_id').notNull(),
  expires_at: integer('expires_at'),    // Unix timestamp, null = unlimited
  created_at: integer('created_at').default(sql'(unixepoch())'),
  updated_at: integer('updated_at').default(sql'(unixepoch())'),
});
```

### 9.3 Modified Files

| File | Change |
|---|---|
| `app/[locale]/(routes)/onboarding/onboarding-wizard.tsx` | Redirect to license activation after completing onboarding when unlicensed |
| `app/lib/auth-guards.ts` | Require a valid license for main app routes |
| `app/lib/db/schema.ts` | Add `license_certs` table |
| `scripts/docker-entrypoint.sh` | Generate instance ID if not present, store in `/data/instance-id` |
| `scripts/start-services.sh` | Initialize LicenseManager before Next.js starts |
| `app/lib/pi/model-resolver.ts` | `isCanvasControlPlaneManagedAvailable()` also implies managed license |

### 9.4 LicenseManager Core Logic

```ts
export class LicenseManager {
  private cert: LicenseCert | null = null;
  private instanceId: string;
  private publicKey: string;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.instanceId = this.resolveInstanceId();
    this.publicKey = process.env.CANVAS_LICENSE_PUBLIC_KEY ?? DEFAULT_PUBLIC_KEY;
  }

  async init(): Promise<void> {
    // 1. If CANVAS_LICENSE_CERT env var is set (managed), use it directly
    if (process.env.CANVAS_LICENSE_CERT) {
      const verified = this.verifyJWT(process.env.CANVAS_LICENSE_CERT);
      if (verified) {
        this.cert = verified;
        await this.saveCertToDB(process.env.CANVAS_LICENSE_CERT);
        this.scheduleRefresh();
        return;
      }
    }

    // 2. If managed (has CANVAS_INSTANCE_ID + CANVAS_INSTANCE_TOKEN),
    //    try fetching managed license from Control Plane
    if (isCanvasControlPlaneManagedAvailable()) {
      await this.fetchManagedLicense();
      if (this.cert) {
        this.scheduleRefresh();
        return;
      }
    }

    // 3. Try loading from SQLite DB
    const stored = await this.loadCertFromDB();
    if (stored) {
      const verified = this.verifyJWT(stored);
      if (verified && !this.isExpired(verified)) {
        this.cert = verified;
        this.scheduleRefresh();
        return;
      }
      // Expired but still valid structure → try refresh
      if (verified) {
        await this.refresh();
        return;
      }
    }

    // 4. No valid license → unregistered
    this.cert = null;
  }

  isLicensed(feature: string): boolean {
    // Managed instances always have all features
    if (this.cert?.plan === 'managed') return true;
    return this.cert?.features[feature] ?? false;
  }

  getValue(quota: string): number | undefined {
    return this.cert?.quotas[quota];
  }

  getPlan(): string {
    return this.cert?.plan ?? 'unregistered';
  }

  isManaged(): boolean {
    return this.cert?.plan === 'managed';
  }

  isRegistered(): boolean {
    return this.cert !== null;
  }

  private resolveInstanceId(): string {
    // 1. CANVAS_INSTANCE_ID (managed)
    // 2. /data/instance-id file (persisted across restarts)
    // 3. Generate new UUID and persist
  }

  // ... register(), activate(), refresh(), verifyJWT(), etc.
}
```

### 9.5 Feature Gating — Frontend

```tsx
// app/components/license/LicenseGate.tsx
import { useLicenseStore } from '@/app/lib/license-store';

interface LicenseGateProps {
  feature: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export function LicenseGate({ feature, children, fallback }: LicenseGateProps) {
  const { features } = useLicenseStore();
  
  if (features[feature]) {
    return <>{children}</>;
  }

  if (fallback) {
    return <>{fallback}</>;
  }

  return <UpgradePrompt feature={feature} />;
}

LicenseGate.Fallback = ({ children }: { children: React.ReactNode }) => <>{children}</>;
```

```tsx
// Usage:
<LicenseGate feature="folders">
  <FoldersUI />
  <LicenseGate.Fallback>
    <UpgradePrompt feature="folders" />
  </LicenseGate.Fallback>
</LicenseGate>
```

### 9.6 Feature Gating — Backend (API Routes)

```ts
// app/lib/license/route-guards.ts
import { getLicenseManager } from '@/app/lib/license';

export function requireLicense(feature: string) {
  return async (request: NextRequest): Promise<NextResponse | null> => {
    const manager = getLicenseManager();
    if (!manager.isLicensed(feature)) {
      return NextResponse.json(
        { error: 'Plan lacks license for this feature', feature },
        { status: 403 }
      );
    }
    return null; // pass through
  };
}
```

```ts
// Usage in an API route:
export async function POST(req: NextRequest) {
  const blocked = await requireLicense('folders')(req);
  if (blocked) return blocked;

  // ... actual logic
}
```

### 9.7 License Activation Screen

Placed after onboarding completion. Unlike the earlier soft-registration draft, self-hosted instances cannot skip this step:

```tsx
// Pseudo-code
function OnboardingWizard() {
  const [step, setStep] = useState('language'); // language → provider → done
  
  const onComplete = async () => {
    await markOnboardingComplete();
    
    const status = await fetch('/api/license/status').then((res) => res.json());
    router.push(status.plan === 'unregistered' ? '/settings?tab=license' : '/');
  };
  
  return (
    <>
      {/* ... wizard steps ... */}
    </>
  );
}
```

## 10. Environment Variables

### Notebook App (New)

| Variable | Purpose | Default |
|---|---|---|
| `CANVAS_LICENSE_PUBLIC_KEY` | RSA public key for JWT verification (PEM or base64) | Embedded default key |
| `CANVAS_LICENSE_CERT` | Pre-provisioned license JWT (for managed instances) | None |
| `CANVAS_INSTANCE_ID` | Already exists — used as license `sub` claim | Auto-generated UUID in `/data/instance-id` |
| `CANVAS_CONTROL_PLANE_URL` | Already exists — used for license API calls | None |
| `CANVAS_INSTANCE_TOKEN` | Already exists — used for auth with license API | None |
| `CANVAS_MANAGED_SERVICES_ENABLED` | Already exists — if true, auto-managed license | `false` |
| `CANVAS_LICENSE_CONTROL_PLANE_URL` | Override Control Plane URL for license operations only | Falls back to `CANVAS_CONTROL_PLANE_URL` |

### Control Plane (New)

| Variable | Purpose | Default |
|---|---|---|
| `LICENSE_PRIVATE_KEY_PATH` | Path to RSA private key for signing JWTs | `./keys/license-private.pem` |
| `LICENSE_PUBLIC_KEY_PATH` | Path to RSA public key | `./keys/license-public.pem` |
| `LICENSE_COMMUNITY_EXPIRY_DAYS` | Days until community license expires | `365` |
| `LICENSE_MANAGED_EXPIRY_DAYS` | Days until managed license expires (before auto-renewal) | `90` |
| `SMTP_*` | Already exists — used for sending license key emails | — |

## 11. Sequence Diagrams

### 11.1 Community Registration

```
User                Notebook App            Control Plane           Email
 |                      |                        |                    |
 |  Complete Onboarding |                        |                    |
 |--------------------->|                        |                    |
 |                      |                        |                    |
 |  Show Registration   |                        |                    |
 |  Modal               |                        |                    |
 |<---------------------|                        |                    |
 |                      |                        |                    |
 |  Enter email + submit|                        |                    |
 |--------------------->|                        |                    |
 |                      |  POST /v1/license/register               |
 |                      |  { email, instanceId }  |                    |
 |                      |----------------------->|                    |
 |                      |                        |  Create key        |
 |                      |                        |  Save to DB         |
 |                      |                        |  Send email         |
 |                      |                        |------------------->|
 |                      |                        |                    |----> User inbox
 |                      |  { title, text }       |                    |
 |                      |<-----------------------|                    |
 |                      |                        |                    |
 |  Show toast:         |                        |                    |
 |  "Key sent to email" |                        |                    |
 |<---------------------|                        |                    |
 |                      |                        |                    |
 |  Click link in email |                        |                    |
 |  /settings/license?key=xxx                    |                    |
 |--------------------->|                        |                    |
 |                      |  POST /v1/license/activate                |
 |                      |  { key, instanceId }    |                    |
 |                      |----------------------->|                    |
 |                      |                        |  Validate key       |
 |                      |                        |  Mark activated      |
 |                      |                        |  Generate JWT        |
 |                      |  { license JWT, plan, features }            |
 |                      |<-----------------------|                    |
 |                      |                        |                    |
 |                      |  Save JWT to SQLite    |                    |
 |                      |  Update UI             |                    |
 |  Community features  |                        |                    |
 |  unlocked            |                        |                    |
 |<---------------------|                        |                    |
```

### 11.2 Managed Auto-License

```
Control Plane                      VM Agent                   Notebook App
     |                                |                            |
     |  Create VM +                   |                            |
     |  managed license in DB         |                            |
     |                                |                            |
     |  Generate JWT for this VM      |                            |
     |                                |                            |
     |  Send env vars via WebSocket   |                            |
     |  CANVAS_MANAGED_SERVICES_ENABLED=true                      |
     |  CANVAS_CONTROL_PLANE_URL=... |                            |
     |  CANVAS_INSTANCE_ID=vm_abc123 |                            |
     |  CANVAS_INSTANCE_TOKEN=ms_xxx |                            |
     |  CANVAS_LICENSE_CERT=<jwt>    |                            |
     |------------------------------->|                            |
     |                                |  Apply env vars            |
     |                                |--------------------------->|
     |                                |                            |
     |                                |                            |  LicenseManager.init()
     |                                |                            |  Detects CANVAS_LICENSE_CERT
     |                                |                            |  Verify JWT with public key
     |                                |                            |  plan = 'managed'
     |                                |                            |  All features unlocked
     |                                |                            |
     |                                |                            |  Schedule background refresh
     |                                |                            |  (every 7 days, via
     |                                |                            |   GET /v1/license/managed)
     |                                |                            |---> Control Plane
     |                                |                            |     (verify still active)
     |                                |                            |<--- refreshed JWT
```

### 11.3 License Refresh (Background)

```
Notebook App                     Control Plane
     |                                |
     |  (every 7 days, or when        |
     |   cert expires within 30 days) |
     |                                |
     |  GET /v1/license/refresh      |
     |  Authorization: Bearer <token>|
     |  X-Instance-ID: <instanceId>   |
     |------------------------------->|
     |                                |
     |                                |  Verify instance is still
     |                                |  active + in good standing
     |                                |  Generate new JWT
     |                                |
     |  { license: <new-jwt> }       |
     |<-------------------------------|
     |                                |
     |  Save new JWT to SQLite       |
     |  Update features in memory     |
     |                                |
     |  (if refresh fails, keep       |
     |   using cached cert until      |
     |   it actually expires)         |
```

## 12. Implementation Order

### Phase 1: Foundation (Notebook App)

1. Create `app/lib/license/features.ts` — feature constants
2. Create `app/lib/license/jwt.ts` — JWT verification with RSA public key
3. Create `app/lib/license/storage.ts` — SQLite persistence
4. Create `app/lib/license/index.ts` — LicenseManager class
5. Create `app/lib/license-store.ts` — Zustand store for frontend
6. Add `license_certs` table to DB schema + migration
7. Generate instance ID on first boot (store in `/data/instance-id`)
8. Initialize LicenseManager in `scripts/start-services.sh` / `server.js`

### Phase 2: Control Plane License Server

1. Generate RSA key pair (`scripts/generate-keys.sh`)
2. Add `licenses` table to PostgreSQL schema + migration
3. Create `apps/api/src/routes/license.ts` with all endpoints
4. Add license auto-provisioning in `ensureManagedEnvForVmConfig()`
5. Add email template for license key delivery
6. Add `CANVAS_LICENSE_CERT` to managed env vars

### Phase 3: Frontend UI

1. Create `CommunityRegistrationModal.tsx`
2. Integrate into onboarding wizard (after `markOnboardingComplete`)
3. Create `LicenseGate.tsx` + `UpgradePrompt.tsx`
4. Create Settings > License page
5. Add `?key=<license-key>` query param support

### Phase 4: Feature Gating

1. Create `app/lib/license/route-guards.ts` for API routes
2. Apply page-level license guard to all main app pages immediately
3. Apply API route license guard to all non-auth, non-onboarding, non-license routes immediately
4. Start applying `LicenseGate` to paid/pro-only features as they are implemented

### Phase 5: Telemetry & Polish

1. Track registration events (email submitted, key activated)
2. Track feature usage by license tier
3. Add license status to health check endpoint
4. Add license info to Control Plane dashboard (VMs page)
5. Handle offline grace periods (cert still valid but can't refresh)

## 13. Security Considerations

1. **Private key stays on the Control Plane** — The notebook only has the public key for JWT verification. JWTs are signed by the Control Plane.
2. **No license server dependency at boot for managed instances** — `CANVAS_LICENSE_CERT` env var provides the license immediately. Only community/pro instances need to reach the Control Plane for activation.
3. **Offline grace period** — If the Control Plane is unreachable during refresh, the cached cert continues working until it actually expires. No hard cutoff on network failure.
4. **Rate limiting** — The registration endpoint must be rate-limited to prevent abuse (e.g., 5 requests per IP per hour).
5. **Instance binding** — License JWTs include the `instanceId` claim. An activation key can only be used once and binds to the instance's ID.
6. **Key rotation** — The public key can be rotated by updating `CANVAS_LICENSE_PUBLIC_KEY` env var. During transition, both old and new public keys should be accepted (support a key array).
7. **Legal protection** — The Sustainable Use License already prohibits competing hosted services. Technical licensing is a complement, not a replacement.

## 14. Open Questions / Future Decisions

- **Exact community features list**: Which features are gated behind community registration? Currently TBD until features are implemented.
- **Pro tier pricing model**: Per-seat? Per-instance? One-time license? Subscription?
- **Pro tier feature list**: What additional features justify a paid self-hosted license?
- **License enforcement strictness**: Decided for self-hosted V1 — hard-block main app usage until license activation succeeds.
- **Offline duration**: How long should a license work without contacting the Control Plane? Currently 365 days for community, 90 days for managed (with auto-renewal).
- **Email provider**: Use existing nodemailer in Control Plane or integrate a transactional email service (Resend, SendGrid)?
- **Public key distribution**: Hardcode in app vs. env var vs. fetch from well-known endpoint?
- **Community registration without Control Plane**: Should standalone self-hosted instances (no Control Plane) be able to register via a hosted service (e.g., license.canvasstudios.io)? Or is the Control Plane the only registration path?
