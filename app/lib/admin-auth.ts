import 'server-only';

import { isBootstrapAdminEmail } from '@/app/lib/bootstrap-admin';

export type AdminUserCandidate = {
  role?: string | null;
  email?: string | null;
};

export function isAdminUser(user: AdminUserCandidate | null | undefined): boolean {
  return Boolean(user?.role === 'admin' || isBootstrapAdminEmail(user?.email));
}
