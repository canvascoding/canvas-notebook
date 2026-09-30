import assert from 'node:assert/strict';
import { localizedAppReturnTo, safeAppReturnTo } from '../app/lib/auth/return-to';
import {
  buildTodoPageHref,
  buildTodoPopupHref,
  isUnmodifiedPrimaryClick,
  todoIdFromHref,
  todoIdFromSearchParams,
} from '../app/lib/todos/navigation';

const base = 'https://canvas.example/de/notebook?session=working#draft';
const todoId = 'todo-123_abc';
assert.equal(buildTodoPopupHref(todoId), '/?todo=todo-123_abc');
assert.equal(buildTodoPopupHref(todoId, 'de'), '/de/?todo=todo-123_abc');
assert.equal(buildTodoPopupHref(todoId, 'en'), '/en/?todo=todo-123_abc');
assert.equal(buildTodoPageHref(todoId), '/todos?todo=todo-123_abc&todoView=page');
assert.equal(new URL(buildTodoPageHref(todoId, 'workspace & 1'), base).searchParams.get('workspaceId'), 'workspace & 1');

for (const href of [
  '/?todo=todo-123_abc', '/de/?todo=todo-123_abc', '/en/?todo=todo-123_abc',
  '/de?todo=todo-123_abc', '/en?todo=todo-123_abc',
  '/todos?todo=todo-123_abc', '/de/todos/?todo=todo-123_abc',
  'https://canvas.example/en/todos?todo=todo-123_abc&workspaceId=other&chat=open',
]) {
  assert.equal(todoIdFromHref(href, base), todoId, href);
}
for (const href of [
  'https://other.example/todos?todo=todo-123_abc',
  'http://canvas.example/todos?todo=todo-123_abc',
  '//other.example/?todo=todo-123_abc',
  'https://user:password@canvas.example/todos?todo=todo-123_abc',
  '/settings?todo=todo-123_abc', '/api/todos?todo=todo-123_abc',
  '/fr/todos?todo=todo-123_abc', '/todos/another?todo=todo-123_abc',
  '/todos?todo=', '/todos?todo=%20todo-123_abc', '/todos?todo=%0Atodo',
  '/todos?todo=todo/123', '/todos?todo=todo-123_abc&todo=todo-123_abc',
  buildTodoPageHref(todoId), 'javascript:alert(1)', 'mailto:todo@example.test',
]) {
  assert.equal(todoIdFromHref(href, base), null, href);
}
assert.equal(todoIdFromHref('/todos?todo=valid', 'invalid base'), null);
assert.equal(todoIdFromSearchParams(new URLSearchParams('todo=todo-123_abc')), todoId);
assert.equal(todoIdFromSearchParams(new URLSearchParams('todo=todo-123_abc&todoView=page')), null);
assert.equal(todoIdFromSearchParams(new URLSearchParams(`todo=${'a'.repeat(201)}`)), null);

const click = { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false };
assert.equal(isUnmodifiedPrimaryClick(click), true);
for (const key of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'defaultPrevented'] as const) {
  assert.equal(isUnmodifiedPrimaryClick({ ...click, [key]: true }), false, key);
}
assert.equal(isUnmodifiedPrimaryClick({ ...click, button: 1 }), false);
assert.equal(isUnmodifiedPrimaryClick({ ...click, button: 2 }), false);
// Email targets survive sign-in; untrusted return targets cannot redirect outside Canvas.
assert.equal(safeAppReturnTo('/?todo=todo-123_abc'), '/?todo=todo-123_abc');
assert.equal(localizedAppReturnTo('/?todo=todo-123_abc', 'en'), '/en/?todo=todo-123_abc');
assert.equal(localizedAppReturnTo('/de/todos?todo=todo-123_abc&todoView=page', 'en'), '/de/todos?todo=todo-123_abc&todoView=page');
for (const target of ['https://other.example', '//other.example', '/\\other.example', '/\nother', 42, null]) {
  assert.equal(safeAppReturnTo(target), null);
  assert.equal(localizedAppReturnTo(target, 'de'), '/de/');
}
console.log('Todo navigation tests passed.');
