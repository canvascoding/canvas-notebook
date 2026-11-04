import pg from 'pg';

/** Test-only acknowledgement failure after a real native receipt COMMIT and
 * real connection release. No SQL result, authorization or storage is mocked. */
export function installIngestCommitCloseFault() {
  const originalQuery = pg.Client.prototype.query;
  const receiptClients = new WeakSet<object>();
  let armed = true, fired = false;
  pg.Client.prototype.query = function (this: pg.Client | pg.PoolClient, ...args: unknown[]) {
    const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? '';
    const pending = Reflect.apply(originalQuery, this, args);
    if (!pending || typeof pending.then !== 'function') return pending;
    const client = this as pg.PoolClient;
    return pending.then((value: unknown) => {
      if (/INSERT INTO collaboration_markdown_file_import_receipts/i.test(text)) receiptClients.add(client);
      if (armed && /^COMMIT$/i.test(text.trim()) && receiptClients.has(client)) {
        const release = client.release;
        client.release = error => {
          client.release = release; release(error);
          if (armed) {
            armed = false; fired = true;
            throw new Error('Test-only lost cleanup acknowledgement after native receipt commit');
          }
        };
      }
      return value;
    });
  } as typeof originalQuery;
  return { fired: () => fired, restore: () => { armed = false; pg.Client.prototype.query = originalQuery; } };
}
