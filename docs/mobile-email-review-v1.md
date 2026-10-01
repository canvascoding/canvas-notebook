# Mobile email review v1

Capability: `email.review.v1` in both compatibility and authenticated bootstrap.
Existing detail GET and send POST fields remain available. Clients without this
capability can continue to use their previous read/send workflow.

All endpoints require a session. Detail and mutation requests use
`X-Canvas-Workspace-Id` and the normal workspace authorization gate. Reads need
`canRead`; all mutations need `canWrite` and a current `expectedVersion`.

## Queue

`GET /api/mobile/v1/email/reviews?scope=selected&filter=all&limit=30`

- `scope`: `selected` (default) uses the same included, authorized workspaces as
  aggregate Inbox through `loadMobileInboxScope`; `current` uses the request's
  active workspace header.
- `filter`: `all` (default) or `problems` (`send_failed` and `send_uncertain`).
- `limit`: integer 1–100, default 30. `cursor`: opaque `nextCursor` from the last
  page. Cursors are bound to user, scope, filter and authorized source IDs.
- Ordering is newest update first, with a stable draft key tie-breaker.
- Every pending draft appears independently, including multiple drafts belonging
  to the same case. Personal outbox is loaded once per selected scope. `sent` and
  `discarded` entries are omitted; `sending` and `send_uncertain` remain visible.

```json
{
  "success": true,
  "data": [
    {
      "id": "draft-123",
      "status": "awaiting_review",
      "version": 4,
      "subject": "Prepared report",
      "body": "<p><strong>Ready for review</strong></p>",
      "to": ["recipient@example.test"],
      "cc": [],
      "bcc": [],
      "isHtml": true,
      "editingByOther": false,
      "canSend": true,
      "canEdit": true,
      "canReject": true,
      "scope": "workspace",
      "workspaceId": "workspace-123",
      "workspaceName": "Team",
      "senderAddress": "sender@example.test",
      "mailboxId": "mailbox-123",
      "accountId": "account-123",
      "attachments": [
        { "id": "draft-123:0", "name": "Report.pdf", "mimeType": "application/pdf", "size": 1234 }
      ],
      "errorCode": null,
      "errorMessage": null,
      "failedAt": null,
      "updatedAt": "2026-10-01T12:00:00.000Z"
    }
  ],
  "pagination": { "nextCursor": null, "total": 1, "problemCount": 0 }
}
```

`total` counts matching pending drafts in this view; `problemCount` counts all
problem drafts in its authorized sources, regardless of filter. Queue rows carry
the full review DTO, including the body. The usual page size is 30; clients should
avoid loading many maximum-sized bodies in one request.

## Detail, save and decisions

- `GET /api/mobile/v1/email/reviews/:draftId` returns
  `{ "success": true, "data": <review DTO> }`.
- `PATCH /api/mobile/v1/email/reviews/:draftId` accepts `expectedVersion` and any
  changed `to`, `cc`, `bcc`, `subject`, `body` fields. Recipient fields are arrays
  with up to 250 individual email addresses; display-address syntax is normalized.
  A body edit is sanitized and stored as HTML. Omit an unchanged body: the service
  preserves its exact bytes and original `isHtml` flag, including legacy text.
  Existing attachments always remain server-owned snapshots; clients cannot
  replace them with this endpoint. All successful writes return the current DTO.
- `POST /api/mobile/v1/email/reviews/:draftId/reject` and `/send` accept
  `{ "expectedVersion": 4 }`. Reject sets `discarded`; send reuses the existing
  policy-checked, atomically reserved delivery service.

The DTO's `workspaceId` is the authorized workspace navigation context, including
for personal scope. It does not reassign personal mail to a workspace.
Attachments expose display metadata only, without private upload tokens or paths.

```json
{ "expectedVersion": 4, "subject": "Reviewed report" }
```

Action flags require write permission, an editable state and no other current
editor. `sending`, `sent`, `discarded`, and `send_uncertain` disable all three
actions. A stale version returns `EMAIL_REVIEW_VERSION_CONFLICT` (409); read-only
mutation attempts return 403. Clients should retain edits on a conflict and offer
an explicit reload.

Send failures preserve the existing structured code and HTTP status:
`SEND_POLICY_BLOCKED` (422), `SEND_FAILED` (502), `SEND_UNCERTAIN` (409). The safe
user-facing error text and fresh review state are returned as:

```json
{
  "success": false,
  "code": "SEND_UNCERTAIN",
  "error": "Delivery could not be confirmed. The provider may have accepted this email. Check Sent mail; retry is disabled to prevent duplicate delivery.",
  "data": {
    "id": "draft-123",
    "status": "send_uncertain",
    "version": 6,
    "canSend": false,
    "canEdit": false,
    "canReject": false
  }
}
```

The real `data` contains the full DTO; the last example abbreviates it. Raw SMTP
errors, stacks and account secrets are never serialized by this adapter. After a
lost send response, reload the detail before another action. Never automatically
repeat a send POST: an uncertain outcome is locked to prevent duplicate delivery.

Verification: `npm run test:mobile:email` runs the adapter and routes over a fresh
in-memory PostgreSQL database with the real schema. It covers scope, pagination,
permissions, version conflicts, content and attachment preservation, rejection,
policy failures and uncertain delivery. `npm run test:email:review` covers the
shared delivery and web review behavior.
