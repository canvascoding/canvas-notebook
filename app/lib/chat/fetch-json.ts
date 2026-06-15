export async function safeFetchJson<T = unknown>(res: Response): Promise<T | null> {
  if (!res.ok) {
    return null;
  }
  const text = await res.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
