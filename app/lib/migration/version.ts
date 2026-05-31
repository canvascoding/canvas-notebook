export function compareAppVersions(a: string, b: string): number {
  const aParts = a.split(/[.-]/u);
  const bParts = b.split(/[.-]/u);
  const length = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < length; i++) {
    const left = aParts[i] ?? '0';
    const right = bParts[i] ?? '0';
    const leftNumber = Number(left);
    const rightNumber = Number(right);

    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1;
      continue;
    }

    const compared = left.localeCompare(right);
    if (compared !== 0) return compared > 0 ? 1 : -1;
  }

  return 0;
}

export function formatVersionCompatibilityMessage(params: {
  exportVersion: string | null;
  currentVersion: string;
  bundleSchemaSupported: boolean;
}) {
  if (!params.bundleSchemaSupported) {
    return {
      compatibility: 'unsupported_bundle_schema' as const,
      canRestore: false,
      message: 'This migration bundle format is not supported by this Canvas version.',
    };
  }

  if (!params.exportVersion) {
    return {
      compatibility: 'unsupported_bundle_schema' as const,
      canRestore: false,
      message: 'This archive does not contain a Canvas migration manifest.',
    };
  }

  const compared = compareAppVersions(params.exportVersion, params.currentVersion);
  if (compared > 0) {
    return {
      compatibility: 'newer_export_blocked' as const,
      canRestore: false,
      message: 'This export was created with a newer Canvas version. Update the target VM before importing it.',
    };
  }

  if (compared < 0) {
    return {
      compatibility: 'older_export_allowed' as const,
      canRestore: true,
      message: 'This export was created with an older Canvas version. Database migrations will run during restore.',
    };
  }

  return {
    compatibility: 'same' as const,
    canRestore: true,
    message: 'This export matches the current Canvas version.',
  };
}
