# Notebook browser roundtrip

Use the managed local Team Seat stack and its host development environment. Do not start another stack or rebuild containers for these tests. Stop an existing host dev server before starting the instrumented one below.

```sh
export CANVAS_BROWSER_ROUNDTRIP_SOCKET="$(mktemp -d /tmp/canvas-browser-roundtrip.XXXXXX)/driver.sock"
export CANVAS_ENV_FILE="$HOME/.local/state/canvas-local-team-seat/notebook-host-dev.env"
export PORT=3000
export NODE_OPTIONS="--require $PWD/scripts/browser-roundtrip-driver.cjs"
npm run dev
```

Wait for `http://localhost:3000/api/health` to return 200. In a second terminal, use the same socket path:

```sh
export CANVAS_BROWSER_ROUNDTRIP_SOCKET=/tmp/canvas-browser-roundtrip.XXXXXX/driver.sock
E2E_EXTERNAL_SERVER=1 BASE_URL=http://localhost:3000 \
  DOTENV_CONFIG_PATH="$HOME/.local/state/canvas-local-team-seat/notebook-host-dev.env" \
  node --require dotenv/config node_modules/@playwright/test/cli.js \
  test tests/browser-lab.spec.ts --grep 'real agent browser roundtrip|startup awaits' --workers=1
```

The preload exposes only a private Unix socket, requires the user's real authenticated cookie and session ownership, and rejects production mode. It calls the actual browser tool implementation in the custom server process, sharing Chromium and runtime state with the app. No chat WebSocket, browser WebSocket, runtime status, or browser action is mocked in these tests. The test invokes the tool deterministically; it does not ask an LLM to choose tool calls or consume model inference.

Both desktop and mobile tests verify:

- Tool opens Chromium while Notebook is already showing the session.
- Real runtime status makes the browser work area appear and connect automatically.
- User answers a real JavaScript prompt through the streamed browser UI.
- Tool reads the resulting page title and the runtime reports a newer interaction revision.
- Another session does not show the first session's browser; returning reconnects to the correct page.
- Tool closes the session, the browser work area and chat link disappear, and runtime status stays stopped.

An additional test starts a page that opens a prompt during initial navigation. Notebook must connect and allow answering it before a first frame exists and while the agent's start action is still pending.

Each test creates and removes its own agent, sessions, and browser profile. Prompt screenshots are written to `test-results/notebook-browser-prompt-{1440,390}.png`. Without the explicit socket environment, these three tests are skipped; the regular Browser Lab suite remains usable with an ordinary server.

Stop the instrumented dev server and remove its empty temporary socket directory afterward. Unset `NODE_OPTIONS` and `CANVAS_BROWSER_ROUNDTRIP_SOCKET` before starting a normal server.

Additional focused checks:

```sh
npm run test:notebook:browser
npm run test:browser:connection
npm run test:browser:lifecycle
```

The remaining Browser Lab UI tests cover delayed tickets, stale connection callbacks, bounded retries, delayed old-connection cleanup, stale-frame input locking, hover, pointer cancellation, multiple viewers, manual reopen, mobile layout, and workspace transfers.
