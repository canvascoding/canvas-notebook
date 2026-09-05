import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserViewConnection } from '../app/lib/pi/browser/client-connection';

class FakeSocket {
  readyState = 1;
  messages: unknown[] = [];
  onClose = () => {};
  send(value: string) { this.messages.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.onClose(); }
  asSocket() { return this as unknown as WebSocket; }
}

async function main() {
  const connection = new BrowserViewConnection();
  let timeouts = 0;
  const first = connection.begin(() => { timeouts += 1; }, 5);
  const signal = first.signal;
  let resolveTicket!: () => void;
  const ticket = new Promise<void>((resolve) => { resolveTicket = resolve; });
  let openedSocket = false;
  const pending = ticket.then(() => {
    if (!first.isCurrent()) return;
    openedSocket = true;
    first.attach(new FakeSocket().asSocket());
  });
  connection.close();
  assert.equal(signal.aborted, true);
  resolveTicket();
  await pending;
  assert.equal(openedSocket, false, 'late ticket responses must not open a socket');

  const replaced = connection.begin(() => { timeouts += 1; }, 5);
  const oldSocket = new FakeSocket();
  replaced.attach(oldSocket.asSocket());
  let unexpectedClose = false;
  oldSocket.onClose = () => { if (replaced.isCurrent()) unexpectedClose = true; };
  const active = connection.begin(() => { timeouts += 1; }, 20);
  assert.equal(unexpectedClose, false, 'invalidation must happen before socket close callbacks');
  assert.equal(replaced.signal.aborted, true);
  const lateSocket = new FakeSocket();
  assert.equal(replaced.attach(lateSocket.asSocket()), false);
  assert.equal(lateSocket.readyState, 3);
  const currentSocket = new FakeSocket();
  active.attach(currentSocket.asSocket());
  replaced.close();
  replaced.ready();
  assert.equal(active.isCurrent(), true, 'stale callbacks must not close the replacement');
  assert.equal(connection.send({ type: 'heartbeat' }), true);
  assert.deepEqual(currentSocket.messages, [{ type: 'heartbeat' }]);
  assert.deepEqual(oldSocket.messages, []);
  await delay(30);
  assert.equal(timeouts, 1, 'the deadline also applies before a ready packet');
  assert.equal(active.signal.aborted, true);
  assert.equal(connection.send({ type: 'heartbeat' }), false);

  const stalledTicket = connection.begin(() => { timeouts += 1; }, 5);
  await delay(15);
  assert.equal(stalledTicket.signal.aborted, true, 'the deadline must include the ticket request');
  assert.equal(timeouts, 2);

  const ready = connection.begin(() => { timeouts += 1; }, 5);
  ready.attach(new FakeSocket().asSocket());
  ready.ready();
  await delay(15);
  assert.equal(ready.isCurrent(), true);
  assert.equal(timeouts, 2, 'a ready connection cancels its connection deadline');
  connection.close();
  connection.close();
  assert.equal(ready.isCurrent(), false);
  console.log('browser-connection-lifecycle-test: ok');
}

void main();
