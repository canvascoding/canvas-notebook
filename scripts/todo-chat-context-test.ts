import assert from 'node:assert/strict';

import { buildTodoPageChatContext } from '../app/apps/todos/context/todo-route-chat-context';

assert.deepEqual(buildTodoPageChatContext('todo-1'), {
  todoContext: { todoId: 'todo-1' },
});
assert.deepEqual(buildTodoPageChatContext('  todo-2  '), {
  todoContext: { todoId: 'todo-2' },
});
assert.equal(buildTodoPageChatContext(null), null);
assert.equal(buildTodoPageChatContext('   '), null);
assert.equal('title' in (buildTodoPageChatContext('todo-1')?.todoContext ?? {}), false);

console.log('todo-chat-context-test: ok');
