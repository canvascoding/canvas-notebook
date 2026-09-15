export const MOBILE_INBOX_FILE_CHANGES_CAPABILITY = 'inbox.file_changes.v1' as const;

export function mobileInboxFileChangesRequested(searchParams: URLSearchParams): boolean {
  return searchParams.getAll('capability').includes(MOBILE_INBOX_FILE_CHANGES_CAPABILITY);
}
