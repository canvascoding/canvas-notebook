import type { ReactNode } from 'react';

/** Load the real client context after a test has installed its browser globals. */
export async function createDocumentReviewUiFixture() {
  const { DocumentReviewAvailabilityContext } = await import(
    '../../app/components/file-version-center/DocumentReviewAvailabilityProvider'
  );
  return function DocumentReviewUiFixture({ enabled, children }: {
    enabled: boolean;
    children: ReactNode;
  }) {
    return <DocumentReviewAvailabilityContext.Provider value={{
      documentReviewEnabled: enabled,
      updatedAt: enabled ? '2026-09-30T12:00:00.000Z' : '2026-09-30T11:00:00.000Z',
      ready: true,
      applyAvailability: () => {},
    }}>
      {children}
    </DocumentReviewAvailabilityContext.Provider>;
  };
}
