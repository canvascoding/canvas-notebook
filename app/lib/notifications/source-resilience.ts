export type NotificationSourceStatus = {
  available: boolean;
  errorCode?: 'source_unavailable';
};

export async function settleNotificationSource<T>(
  promise: Promise<T>,
  fallback: T,
): Promise<{ value: T; status: NotificationSourceStatus }> {
  try {
    return { value: await promise, status: { available: true } };
  } catch {
    return {
      value: fallback,
      status: { available: false, errorCode: 'source_unavailable' },
    };
  }
}
