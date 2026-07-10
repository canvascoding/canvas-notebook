import assert from 'node:assert/strict';

import {
  AgentConfigValidationError,
  validateManagedAgentFileContent,
} from '../app/lib/agents/storage';
import { getManagedAgentFileLimitBytes } from '../app/lib/agents/managed-file-limits';

validateManagedAgentFileContent('MEMORY.md', 'A compact durable fact.');

assert.throws(
  () => validateManagedAgentFileContent('MEMORY.md', 'x'.repeat(getManagedAgentFileLimitBytes('MEMORY.md') + 1)),
  (error: unknown) => error instanceof AgentConfigValidationError && /MEMORY\.md is too large/.test(error.message),
);

console.log('managed agent file limit tests passed');
