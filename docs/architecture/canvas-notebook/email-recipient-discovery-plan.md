# Email recipient discovery

The agent resolves a named recipient from observed mailbox headers and prepares a human-reviewed draft. Optional additional recipients require a visible selection. This feature never sends mail.

## Progressive disclosure

- Keep existing email tools compatible. Add one `email_recipients` gateway with `email_find_recipients` and `email_suggest_reply_recipients`; search returns summaries, describe loads one schema, call executes only a permitted operation.
- Do not inject contacts, message history, or recipient schemas into persistent chat context. Add only brief guidance when the gateway is available.
- Name lookup searches From/To/Cc in one authorized mailbox, one page of 25 messages per explicit call. Return at most five candidates, compact source references, and independent coverage/ambiguity information. No bodies, snippets, Bcc, or automatic paging. Source details remain accessible via the existing message reader.
- Local Gmail, Microsoft and IMAP lookup uses address metadata, with an initial 100-candidate provider scan budget. An explicit later offset may expand that bounded scan; normal mailbox searches retain their full-text behavior. Managed mailbox search uses the existing Control Plane contract and does not claim the same local I/O optimization.
- Compact service output is capped at 7,500 characters, reserving space for the tool notice. Keep candidate count and ambiguity before truncation; incomplete, policy-limited or later-page results never claim unique mailbox-wide resolution.
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

## Implemented decisions

- `email_recipients` exposes `search -> describe -> call`; the new operations do not add their full schemas to the initial tool list. Existing direct email tools remain compatible. Capability guidance adds roughly 500 characters and only when recipient discovery is enabled.
- Prior default Email profiles migrate to include both operations. Customized or disabled capability selections remain unchanged. Automation mailbox binding applies to gateway operations and cannot restore an unavailable capability.
- Authorization resolves the actor's mailbox catalogue before and after provider I/O. Human lookup requires read access; agent lookup additionally requires agent access and follows sender restrictions. Access or connection revisions changing during lookup invalidate the result.
- Compose and Review share the picker and structural address tokenizer. Form recipient lists retain all entered addresses; provider metadata parsing and network exclusions have separate bounds. Complete manual addresses bypass lookup, and unresolved names remain visible as invalid entries.
- Self-address filtering includes the selected sender and personal aliases. Other accessible shared mailboxes remain valid reply participants. Reply-To and deduplication use the same derivation on the server and in Compose.
- Optional reply participants are drawn from the selected message only and added individually to To or Cc. Source labels describe an observed header and its date, without claiming verified delivery or a complete conversation.

Focused validation entry points are `test:email:addresses`, `test:email:recipients`, `test:pi:email-recipients`, `test:email:recipients:ui`, the compose source/dialog tests, the Review store test and the existing provider/cache suites. Browser acceptance and real-provider acceptance are separate from these local tests.
