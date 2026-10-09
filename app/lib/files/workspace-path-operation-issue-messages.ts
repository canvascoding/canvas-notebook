export const workspacePathOperationIssueKeys: Record<string, string> = {
  'missing-source': 'missingSource', 'destination-collision': 'destinationCollision',
  'invalid-path': 'invalidPath', 'overlapping-selection': 'overlap', 'overlapping-edits': 'overlap', 'unsupported-overlap': 'overlap',
  'duplicate-destination': 'duplicateDestination', 'directory-cycle': 'directoryCycle',
  'incomplete-index': 'incompleteIndex', 'stale-content': 'staleContent',
  'unsupported-target-format': 'unsupportedLink', 'unsupported-delete-link': 'unsupportedLink',
  'affected-unresolved-link': 'unresolvedLink', 'uninspected-source': 'uninspectedSource',
  'unevaluated-link': 'unsupportedLink', 'resolution-changed': 'resolutionChanged',
  'action-limit': 'limit', 'path-limit': 'limit', 'missing-selection': 'missingSelection',
  'duplicate-review': 'invalidAction', 'invalid-action': 'invalidAction',
  'unsupported-action': 'unsupportedAction', 'unsupported-operation': 'unsupportedAction',
  'cross-workspace-move': 'crossWorkspaceMove', 'uncopied-cross-workspace-target': 'uncopiedTarget',
};
