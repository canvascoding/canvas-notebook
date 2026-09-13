# To-do bulk actions

The square checkboxes select to-dos without opening their details or marking them read. The existing round completion control remains independent.

- **Select all** resolves the current scope, category, status, read-state and priority filters on the server, including matches beyond the 100 displayed rows. Read-only entries are excluded and counted.
- The selection is a snapshot of explicit IDs and versions. New arrivals are not silently added. Changing filters clears the selection and cancels outstanding selection requests.
- Up to 1,000 matches can be selected. A larger result set requires narrower filters; it is never silently truncated.
- Actions include completion, reopening, category changes, priority, assignment, deletion and restoration. Moving means changing category, not transferring workspace ownership or file links.
- Deletion requires confirmation and moves entries to Recently deleted. Archived and active entries must be selected separately. Completion does not send agent follow-ups.
- Permissions, target validity, lifecycle and selected versions are checked for every entry. Writes run in one PostgreSQL transaction; a failure rolls back the entire batch. No-op entries count as successfully processed without changing their version.
- On conflict, refresh the list, clear the selection and review it again. A lost connection can leave the outcome unknown; the UI does not claim rollback or automatically retry.
- Ctrl/Cmd+A selects all only while focus is inside the list, outside text fields and dialogs. Escape clears selection. Bulk controls remain available on narrow screens.

## Verification

Use the existing managed local development environment; do not create another test stack. Supply its private environment without copying credentials into source control.

```sh
node --env-file=/absolute/path/to/notebook-host-dev.env --import tsx --conditions react-server scripts/todo-bulk-test.ts
TODO_BULK_UI_TEST=1 node --env-file=/absolute/path/to/notebook-host-dev.env scripts/todo-bulk-ui-test.mjs
npm run lint
npm run build
```

The store suite creates and drops its own temporary PostgreSQL database and also runs the existing store regression suite. The UI suite requires a current server at `BASE_URL` and explicit browser-test approval. It logs in with the bootstrap credentials, creates uniquely identified test categories/to-dos, and deletes only those fixtures in `finally`.

UI checks cover 105 selected rows, excluded filter matches, a late arrival, unchanged unread state, conflict handling, category movement, filter resets, keyboard selection, delete confirmation, restoration, mobile layout, read-only exclusions and delayed selection responses. The store suite additionally covers the selection limit, authorization failures, target validation, no-ops, and rollback after an injected late SQL failure.
