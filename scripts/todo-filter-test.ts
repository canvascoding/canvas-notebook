import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('app/apps/todos/components/TodosClient.tsx', 'utf8');

assert.match(source, /function todoMatchesStatusFilter\(todoStatus: TodoStatus, statusFilter: StatusFilter\)/);
assert.match(source, /todoMatchesStatusFilter\(deepLinkedTodo\.status, statusFilter\)/);
assert.match(source, /current && data\.some\(\(todo\) => todo\.id === current\)/);
assert.match(source, /if \(!todoMatchesStatusFilter\(updated\.status, statusFilter\)\)/);

console.log('todo filter regression contract passed');
