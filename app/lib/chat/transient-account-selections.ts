/** Tab-memory only. Exact account confirmations survive internal navigation,
 * never a reload, persistent draft, clipboard or signed-in scope change. */
export type TransientAccountSelection = { receipt: string; expiresAt: number };
const scopes = new Map<string, Map<string, TransientAccountSelection>>();

export function getTransientChatAccountSelections(scope: string): Map<string, TransientAccountSelection> {
  for (const [key, entries] of scopes) {
    for (const [identity, entry] of entries) if (entry.expiresAt <= Date.now()) entries.delete(identity);
    if (!entries.size) scopes.delete(key);
  }
  let entries = scopes.get(scope);
  if (!entries) {
    entries = new Map(); scopes.set(scope, entries);
    while (scopes.size > 20) scopes.delete(scopes.keys().next().value!);
  }
  return entries;
}
