import type { CapabilityResourceOwnerScope } from '../resources/contracts';
import type { CapabilityPackagePresentation } from './presentation-contracts';

export type CapabilityPackageDraftContents = Pick<CapabilityPackagePresentation,
  'children' | 'capabilities' | 'requirements' | 'scripts' | 'compatibility' | 'requiredEnv'>;

/** Historical capture facts only; these do not assert that later authoring left the copy unchanged. */
export type CapabilityPackageDraftCaptureSummary = {
  source: 'package' | 'workspace';
  sourceName: string;
  sourceVersion: string;
  parent?: { name: string; version: string };
  targetName: string;
  targetVersionAtCapture: string;
  versionChangedAtCapture: boolean;
  adjustmentsAtCapture: Array<'name' | 'mcp' | 'skill_references' | 'image' | 'markdown' | 'other'>;
};

/** Private authoring preview. None of these fields is a publication or runtime receipt. */
export type CapabilityPackageDraftPresentation = {
  schemaVersion: 1;
  origin: 'draft';
  draftRef: string;
  draftRevision: number;
  checksum: string;
  kind: 'plugin' | 'skill';
  name: string;
  title: string;
  description: string;
  version: string | null;
  ownership: CapabilityResourceOwnerScope;
  authoring: {
    operation: 'create' | 'edit' | 'fork';
    intendedAudience: 'not_specified';
    captures: CapabilityPackageDraftCaptureSummary[];
    capturesTruncated: boolean;
  };
  presentation: CapabilityPackageDraftContents | null;
  previewIncomplete: boolean;
  imageAvailable: boolean;
  skills: Array<{name: string; title: string; description: string; version: string | null; path: string; origin: 'captured' | 'not_recorded'}>;
  skillsTruncated: boolean;
};
