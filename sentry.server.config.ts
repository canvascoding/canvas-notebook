// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

const nodeMajorVersion = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const shouldDisableDeprecatedEsmLoaderHooks = nodeMajorVersion >= 26;

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 1,

  // Sentry currently registers ESM import hooks through Node's deprecated
  // module.register() API, which emits DEP0205 on Node 26+.
  ...(shouldDisableDeprecatedEsmLoaderHooks ? { registerEsmLoaderHooks: false } : {}),

  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: true,
});
