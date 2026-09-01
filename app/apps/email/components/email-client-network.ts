export function isFetchNetworkError(error: unknown): boolean {
  return error instanceof TypeError && /failed to fetch|fetch failed|networkerror/iu.test(error.message);
}
