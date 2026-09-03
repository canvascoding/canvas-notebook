import type { Socket } from 'node:net';
import { readTerminalAvailability, subscribeTerminalAvailability, TERMINAL_DISABLED_CODE } from '../app/lib/terminal-policy';

export function createTerminalPolicyEnforcer(
  sessions: Map<string, { clients: Set<Socket> }>,
  terminateSession: (sessionId: string) => void,
) {
  const synchronize = () => {
    const state = readTerminalAvailability();
    let closed = 0;
    if (!state.terminalEnabled) {
      for (const [id, session] of sessions) {
        for (const client of session.clients) {
          if (!client.destroyed) client.end(`${JSON.stringify({ type: 'disabled', code: TERMINAL_DISABLED_CODE })}\n`);
        }
        session.clients.clear();
        terminateSession(id);
        closed++;
      }
    }
    return { ...state, closed };
  };
  const unsubscribe = subscribeTerminalAvailability(synchronize);
  process.once('exit', unsubscribe);
  return synchronize;
}
