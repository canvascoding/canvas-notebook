import 'server-only';

type Runtime = { connections?: (documentId: string) => number; healthy: boolean; checkedAt: number; fatal: boolean };
const runtime = globalThis as typeof globalThis & { __canvasRichMigrationRuntime?: Runtime };

export function installRichMigrationRuntime(connections?: (documentId: string) => number): () => void {
  const installed = { connections, healthy: false, checkedAt: 0, fatal: false };
  runtime.__canvasRichMigrationRuntime = installed;
  return () => { if (runtime.__canvasRichMigrationRuntime === installed) delete runtime.__canvasRichMigrationRuntime; };
}

export function noteRichMigrationWorkerSuccess(): void {
  if (runtime.__canvasRichMigrationRuntime && !runtime.__canvasRichMigrationRuntime.fatal) {
    runtime.__canvasRichMigrationRuntime.healthy = true;
    runtime.__canvasRichMigrationRuntime.checkedAt = Date.now();
  }
}

export function noteRichMigrationWorkerFailure(fatal = false): void {
  if (runtime.__canvasRichMigrationRuntime) {
    runtime.__canvasRichMigrationRuntime.healthy = false;
    runtime.__canvasRichMigrationRuntime.fatal ||= fatal;
  }
}

export function richMigrationRuntimeAvailable(): boolean {
  return runtime.__canvasRichMigrationRuntime?.healthy === true && Date.now() - runtime.__canvasRichMigrationRuntime.checkedAt <= 5_000;
}

export function richMigrationConnectedClients(documentId: string): number | null {
  return runtime.__canvasRichMigrationRuntime?.connections?.(documentId) ?? null;
}
