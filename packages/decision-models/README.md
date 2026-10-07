# Canvas Decision Models

Private, versioned Node package for structured decisions. Canonical source lives in the Canvas Notebook repository. Control Plane consumes a generated copy of this exact package; update it with `node scripts/sync-decision-models-package.mjs --target /absolute/control-plane` and verify the source manifest. Both projects compile the package before their application builds.

Provider adapters, endpoint policy and bounded transport retain their contracts. Email permissions, credentials and product policy belong to the application.
