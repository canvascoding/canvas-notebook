import { CapabilityPackageError, isCapabilityPackageError, type CapabilityPackageValidation } from './contracts';

export type CapabilityPackageValidationIssue = {
  code: string;
  file: string;
  field: string;
  message: string;
  repair: string;
};

/** A report describes these exact private draft bytes; it is never a publication permit. */
export type CapabilityPackageDraftValidationReport = CapabilityPackageValidation & {
  validationVersion: 1;
  draftRevision: number;
  manifestSchemaVersion: 1 | null;
  issues: readonly CapabilityPackageValidationIssue[];
};

export class CapabilityPackageValidationError extends CapabilityPackageError {
  constructor(readonly validation: CapabilityPackageDraftValidationReport) {
    super('PACKAGE_INVALID', validation.issues.map(issue => `${issue.file} (${issue.field}): ${issue.message} ${issue.repair}`).join(' ')
      || validation.errors.join(' ') || 'The package is invalid.');
    Object.defineProperty(this, Symbol.for('canvas.capability.package-validation-error.v1'), { value: true });
  }
}

export function capabilityPackageValidationErrorReport(error: unknown): CapabilityPackageDraftValidationReport | undefined {
  return isCapabilityPackageError(error) && Reflect.get(error, Symbol.for('canvas.capability.package-validation-error.v1')) === true
    ? (error as CapabilityPackageValidationError).validation : undefined;
}
