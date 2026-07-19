import 'server-only';

export type BrowserViewRateLimitState = {
  inputWindowStartedAt: number;
  inputCount: number;
  commandWindowStartedAt: number;
  commandCount: number;
};

const INPUT_LIMIT = 120;
const INPUT_WINDOW_MS = 1_000;
const COMMAND_LIMIT = 60;
const COMMAND_WINDOW_MS = 60_000;

export function createBrowserViewRateLimitState(now = Date.now()): BrowserViewRateLimitState {
  return {
    inputWindowStartedAt: now,
    inputCount: 0,
    commandWindowStartedAt: now,
    commandCount: 0,
  };
}

export function allowBrowserViewMessage(
  state: BrowserViewRateLimitState,
  input: boolean,
  now = Date.now(),
): boolean {
  if (input) {
    if (now - state.inputWindowStartedAt >= INPUT_WINDOW_MS) {
      state.inputWindowStartedAt = now;
      state.inputCount = 0;
    }
    state.inputCount += 1;
    return state.inputCount <= INPUT_LIMIT;
  }

  if (now - state.commandWindowStartedAt >= COMMAND_WINDOW_MS) {
    state.commandWindowStartedAt = now;
    state.commandCount = 0;
  }
  state.commandCount += 1;
  return state.commandCount <= COMMAND_LIMIT;
}
