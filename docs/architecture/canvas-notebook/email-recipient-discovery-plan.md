# Email recipient discovery

The agent resolves a named recipient from observed mailbox headers and prepares a human-reviewed draft. Optional additional recipients require a visible selection. This feature never sends mail.

## Progressive disclosure

- Keep existing email tools compatible. Add one `email_recipients` gateway with `email_find_recipients` and `email_suggest_reply_recipients`; search returns summaries, describe loads one schema, call executes only a permitted operation.
- Do not inject contacts, message history, or recipient schemas into persistent chat context. Add only brief guidance when the gateway is available.
- Name lookup searches From/To/Cc in one authorized mailbox, one page of 25 messages per explicit call. Return at most five candidates, compact source references, and independent coverage/ambiguity information. No bodies, snippets, Bcc, or automatic paging. Source details remain accessible via the existing message reader.
- Reply suggestions inspect only the explicitly selected message. Identify the basis as `current_message`; do not claim complete thread coverage. The legacy thread-list tool's completeness is outside this bounded feature.
- UI lookup starts after focused typing of two characters and a debounce. Details and optional reply participants remain collapsed until requested. All selection is explicit.
- No new provider contact scopes or permanent address index. Add those only if observed latency or missing history justifies a separate design.

## Ordered implementation

1. Preserve structured names and Reply-To across provider/cache normalization; share address parsing and reply/reply-all derivation between server and UI. Validate and commit.
2. Implement bounded recipient lookup and current-message suggestions with sender-policy filtering, source references, explicit coverage and no inferred addresses. Validate and commit.
3. Register operations behind the gateway, preserve customized tool selections, and retain server-bound automation mailbox restrictions. Validate discovery, schema budgets and output bounds; commit.
4. Use a common picker in Compose and Review, with scope/race isolation and accessible keyboard selection. Integrate optional current-message participant suggestions. Validate component behavior and production build, then perform authorized browser QA and commit.

## Acceptance

Cover same names, private/business addresses, missing names, quoted commas, Reply-To, own addresses, cross-field duplicates, Bcc, no-reply, blocked sender policies, shared/personal mailbox boundaries, provider partial coverage, output bounds, custom capabilities and automation bindings. Browser use needs explicit user authorization; containers require separate authorization.
