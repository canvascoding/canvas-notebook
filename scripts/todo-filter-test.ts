import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('app/apps/todos/components/TodosClient.tsx', 'utf8');

assert.match(source, /function todoMatchesStatusFilter\(todoStatus: TodoStatus, statusFilter: StatusFilter\)/);
assert.match(source, /const visibleTodos = useMemo\(/);
assert.match(source, /visibleTodos\.map\(\(todo\) =>/);
assert.match(source, /current && \(data\.some\(\(todo\) => todo\.id === current\) \|\| current === todoIdParam\)/);
assert.match(source, /if \(!todoMatchesStatusFilter\(updated\.status, statusFilter\)\)/);

const listStart = source.indexOf('visibleTodos.map((todo) =>');
const previewStart = source.indexOf('<MarkdownRenderer content={todo.description}', listStart);
assert.ok(listStart >= 0 && previewStart > listStart);
assert.ok(source.lastIndexOf('</button>', previewStart) > source.lastIndexOf('<button', previewStart));

console.log('todo filter regression contract passed');
