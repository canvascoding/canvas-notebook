import assert from 'node:assert/strict';
import { types } from 'node:util';

/** Next's automatic dynamic tracking wraps the actual Request at its route boundary. */
export function frameworkTrackedRequest<T extends Request>(request: T): T {
  const wrapped = new Proxy(request, {
    get(target, property) { return Reflect.get(target, property, target); },
  });
  assert(types.isProxy(wrapped));
  assert.equal(wrapped.headers, request.headers);
  assert.equal(wrapped.signal, request.signal);
  return wrapped;
}
