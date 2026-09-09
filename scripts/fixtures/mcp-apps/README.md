# MCP App fixtures

These fixtures build small official MCP Apps v2 test applications used for
Canvas widget acceptance tests. Build them from the repository root with:

```sh
node scripts/fixtures/mcp-apps/build.mjs
```

This produces `scripts/fixtures/mcp-apps/dist/`. The generated distribution is
intentionally ignored because it is large and reproducible.
