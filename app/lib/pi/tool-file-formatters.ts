import {
  type AgentFileChangeResult,
  type AgentPathOperationResult,
  type AgentFileValidationResult,
} from '@/app/lib/pi/agent-file-operations';

function formatValidation(validation: AgentFileValidationResult): string {
  return validation.checks
    .map((check) => `- ${check.ok ? 'OK' : 'FAILED'} ${check.name}: ${check.message}`)
    .join('\n');
}

export function formatFileChangeResult(result: AgentFileChangeResult): string {
  let action = 'Checked';
  if (result.changed) {
    action = result.snapshot?.existed === false ? 'Created' : 'Updated';
  } else if (result.collaboration?.reviewRequired) {
    action = 'Prepared review for';
  }

  return [
    `${action} file: ${result.path}`,
    result.collaboration
      ? `Live collaboration operation: ${result.collaboration.operationId} (${result.collaboration.operationStatus}, ${result.collaboration.durability})`
      : null,
    result.collaboration?.reviewRequired
      ? 'Review ready: the proposed change is available in the editor with Accept and Reject actions. The user does not need to edit the text manually.'
      : null,
    `Snapshot: ${result.snapshot?.id || 'none'}`,
    `Before SHA-256: ${result.beforeSha256 || 'new file'}`,
    `After SHA-256: ${result.afterSha256}`,
    `Size: ${result.size} bytes`,
    `Validation: ${result.validation.ok ? 'passed' : 'failed'}`,
    formatValidation(result.validation),
    '',
    'Diff:',
    '```diff',
    result.diff,
    '```',
  ].filter((line): line is string => line !== null).join('\n');
}

export function formatFileChangeResults(results: AgentFileChangeResult[]): string {
  return results.map((result, index) => `# File ${index + 1}\n${formatFileChangeResult(result)}`).join('\n\n');
}

export function formatPathOperationResult(result: AgentPathOperationResult): string {
  const entryLines = result.entries.length > 1
    ? [
        '',
        'Entries:',
        ...result.entries.slice(0, 20).map((entry, index) => {
          const destination = entry.destinationPath ? ` -> ${entry.destinationPath}` : '';
          return `${index + 1}. ${entry.sourcePath}${destination} (${entry.type}, files ${entry.files}, directories ${entry.directories}, bytes ${entry.bytes})`;
        }),
        result.entries.length > 20 ? `... ${result.entries.length - 20} more entries` : null,
      ].filter(Boolean)
    : [];

  return [
    `Operation: ${result.operation}`,
    `Sources: ${result.sourcePaths.length}`,
    result.sourcePaths.length === 1 ? `Source: ${result.sourcePath}` : null,
    result.destinationPath ? `Destination: ${result.destinationPath}` : null,
    `Type: ${result.type}`,
    `Changed: ${result.changed ? 'yes' : 'no'}`,
    `Overwritten: ${result.overwritten ? 'yes' : 'no'}`,
    `Files: ${result.files}`,
    `Directories: ${result.directories}`,
    `Bytes: ${result.bytes}`,
    result.verified === true ? 'Verification: passed' : result.verified === false ? 'Verification: failed' : 'Verification: not applicable',
    result.truncated ? 'Summary truncated: yes' : 'Summary truncated: no',
    'Snapshot: none (path copy/move/delete operations do not snapshot file contents)',
    ...entryLines,
  ].filter(Boolean).join('\n');
}

export function readPathList(params: Record<string, unknown>, singleKey: string, listKey: string): string[] {
  const paths: string[] = [];
  const singlePath = params[singleKey];
  const pathList = params[listKey];

  if (typeof singlePath === 'string') {
    paths.push(singlePath);
  }
  if (Array.isArray(pathList)) {
    for (const item of pathList) {
      if (typeof item !== 'string') {
        throw new Error(`${listKey} must contain only strings.`);
      }
      paths.push(item);
    }
  }

  const normalized = paths.map((pathValue) => pathValue.trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error(`Provide ${singleKey} or ${listKey}.`);
  }
  return normalized;
}


/**
 * Registry for PI-compatible tools.
 */
