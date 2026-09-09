# Personal MCP accounts and organization approvals

Organization administrators can publish a public HTTP server definition from their own MCP configuration. Members can create separately named personal accounts from enabled definitions. Definitions live under the organization's MCP templates directory; connection IDs, OAuth state, tokens and client registrations remain in the owning user's MCP directory.

Only public HTTP/OAuth metadata is copied. Commands, environment variables, headers, bearer credentials and OAuth client secrets are rejected. Shared URLs cannot contain credentials, query strings or fragments. The normal outbound network policy still applies. STDIO retains its instance-policy restriction and is unavailable to members.

Every runtime entry point requires an explicit user context or the explicit internal `MCP_SYSTEM_SCOPE`. It checks the account/seat, current organization membership, connection owner and current approval. The same checks run before cached tool discovery, direct tool execution and HTTP requests. OAuth start and callback completion recheck authorization. Removing an approval, changing its public configuration, suspending a member or changing the active organization prevents further use of old clients and previously built tools.

An organization association is immutable, including an existing null association. The user config can contain accounts from different past organizations; this does not grant access to them in the current organization. Owners can still remove their old accounts. Credential encryption and OAuth lifecycle records use the selected account's bound organization, even when the authenticated request supplies only the user ID.

Account creation and renaming require unique display names. Stable connection IDs select runtime credentials and form collision-resistant direct tool names; labels do not select credentials. Concurrent personal account edits use a compare-and-write check under the config lock so one edit cannot silently erase another. Only administrators can submit arbitrary configuration JSON.

Settings expose approved definitions and personal account actions to members. Passive status reads do not contact providers. Inaccessible accounts show an access message; they do not generate misleading provider-outage notifications. Authentication failures return 401, permission failures 403, missing connections 404, and conflicting edits or disabled connections 409.

Validation: `npm run test:mcp:member-access`, `npm run test:mcp:api-routes`, `npm run test:mcp:health`, `npm run test:mcp:oauth-lifecycle`, and the manager/direct/proxy regression scripts. Tests use isolated temporary storage and local MCP providers; no production account is required.
