import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { invalidateOpenedDocumentAuth, observeOpenedDocumentAuth } from './collaboration/opened-document-registry';

export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : "",
  plugins: [
    adminClient(),
    oauthProviderClient(),
  ],
});

if (typeof window !== 'undefined') {
  // Reuse BetterAuth's existing session state; no separate authentication cache.
  const session = authClient.$store.atoms.session;
  observeOpenedDocumentAuth(session.get());
  session.listen(observeOpenedDocumentAuth);
  authClient.$store.atoms.$sessionSignal.listen(invalidateOpenedDocumentAuth);
}
