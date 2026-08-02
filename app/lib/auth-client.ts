import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : "",
  plugins: [
    adminClient(),
    oauthProviderClient(),
  ],
});
