import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTodoById } from '../app/apps/todos/components/todo-selection';

type Todo = {
  id: string;
  status: 'open' | 'done' | 'archived';
  title: string;
};

test('prefers the current list item when it is available', () => {
  const listTodo: Todo = { id: 'todo-open', status: 'open', title: 'Open item' };
  const fallbackTodo: Todo = { id: 'todo-open', status: 'archived', title: 'Archived snapshot' };

  assert.equal(resolveTodoById([listTodo], 'todo-open', fallbackTodo), listTodo);
});

test('falls back to the snapshot when the item is filtered out of the list', () => {
  const fallbackTodo: Todo = { id: 'todo-archived', status: 'archived', title: 'Archived item' };

  assert.equal(resolveTodoById([], 'todo-archived', fallbackTodo), fallbackTodo);
});

test('returns null when neither list nor snapshot can satisfy the selected id', () => {
  const fallbackTodo: Todo = { id: 'todo-other', status: 'open', title: 'Other item' };

  assert.equal(resolveTodoById([], 'todo-missing', fallbackTodo), null);
});
