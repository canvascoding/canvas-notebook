export class SharedConnectionRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export type SharedConnectionApi = <T>(url: string, body?: unknown, method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE') => Promise<T>;
