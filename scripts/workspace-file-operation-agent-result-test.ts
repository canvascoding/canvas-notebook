import assert from 'node:assert/strict';

import { formatPathOperationResult } from '../app/lib/pi/tool-file-formatters';
import type { AgentPathOperationResult } from '../app/lib/pi/agent-file-operations';

const result: AgentPathOperationResult = {
  operation: 'move_path',
  sourcePath: 'Notes/chart.png',
  sourcePaths: ['Notes/chart.png'],
  destinationPath: 'Archive/chart.png',
  sourceResolvedPath: '/workspace/Notes/chart.png',
  sourceResolvedPaths: ['/workspace/Notes/chart.png'],
  destinationResolvedPath: '/workspace/Archive/chart.png',
  type: 'file',
  changed: true,
  overwritten: false,
  bytes: 10,
  files: 1,
  directories: 0,
  truncated: false,
  verified: true,
  linkStatus: 'incomplete',
  linkWarnings: ['Local Markdown links were not checked or rewritten by this path operation.'],
  entries: [],
};
const formatted = formatPathOperationResult(result);
assert.match(formatted, /Verification: passed/u);
assert.match(formatted, /Link status: incomplete/u);
assert.match(formatted, /Link warning: Local Markdown links were not checked/u);
console.log('workspace-file-operation-agent-result-test: ok');
