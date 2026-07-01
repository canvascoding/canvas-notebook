import assert from 'node:assert/strict';

import { sqliteToPostgresTablePlan } from '../app/lib/db/sqlite-to-postgres-migration';

const plan = sqliteToPostgresTablePlan();
const position = new Map(plan.map((table, index) => [table, index]));

function before(dependency: string, dependent: string): void {
  assert.ok(position.has(dependency), `missing dependency table: ${dependency}`);
  assert.ok(position.has(dependent), `missing dependent table: ${dependent}`);
  assert.ok(
    position.get(dependency)! < position.get(dependent)!,
    `${dependency} must be copied before ${dependent}`,
  );
}

assert.equal(new Set(plan).size, plan.length, 'table plan must not contain duplicates');

before('user', 'account');
before('user', 'session');
before('user', 'canvas_organization_settings');
before('canvas_organization_settings', 'organization_user_permissions');
before('canvas_organization_settings', 'canvas_workspaces');
before('canvas_projects', 'canvas_project_members');
before('canvas_workspaces', 'workspace_trash_entries');
before('email_accounts', 'email_drafts');
before('todo_items', 'todo_file_links');
before('todo_email_reply_watchers', 'todo_email_reply_events');
before('knowledge_sources', 'knowledge_chunks');
before('automation_jobs', 'automation_runs');
before('automation_jobs', 'automation_webhook_triggers');
before('automation_webhook_triggers', 'automation_webhook_events');
before('studio_products', 'studio_product_images');
before('studio_personas', 'studio_persona_images');
before('studio_styles', 'studio_style_images');

console.log('sqlite-to-postgres migration plan tests passed');
