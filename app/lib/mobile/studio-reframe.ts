import 'server-only';

import type {
  AspectRatioFrame,
  AspectRatioMode,
} from '@/app/lib/integrations/studio-aspect-ratio-service';

import { MobileStudioError } from './studio';

const MINIMUM_FRAME_EDGE = 24;
const RATIO_TOLERANCE = 0.01;

type MobileStudioReframeFrameInput = {
  frame: unknown;
  mode: AspectRatioMode;
  sourceWidth: number;
  sourceHeight: number;
  targetRatio: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidFrame(): never {
  throw new MobileStudioError(
    'The crop frame is invalid.',
    400,
    'INVALID_CROP_FRAME',
  );
}

function finiteCoordinate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidFrame();
  return value;
}

export function centeredMobileStudioReframeFrame(
  sourceWidth: number,
  sourceHeight: number,
  targetRatio: number,
  mode: AspectRatioMode,
): AspectRatioFrame {
  const sourceRatio = sourceWidth / sourceHeight;
  if (mode === 'crop') {
    if (sourceRatio > targetRatio) {
      const width = sourceHeight * targetRatio;
      return { x: (sourceWidth - width) / 2, y: 0, width, height: sourceHeight };
    }
    const height = sourceWidth / targetRatio;
    return { x: 0, y: (sourceHeight - height) / 2, width: sourceWidth, height };
  }
  if (sourceRatio > targetRatio) {
    const height = sourceWidth / targetRatio;
    return { x: 0, y: (sourceHeight - height) / 2, width: sourceWidth, height };
  }
  const width = sourceHeight * targetRatio;
  return { x: (sourceWidth - width) / 2, y: 0, width, height: sourceHeight };
}

export function resolveMobileStudioReframeFrame({
  frame,
  mode,
  sourceWidth,
  sourceHeight,
  targetRatio,
}: MobileStudioReframeFrameInput): AspectRatioFrame {
  const centered = centeredMobileStudioReframeFrame(
    sourceWidth,
    sourceHeight,
    targetRatio,
    mode,
  );
  if (mode !== 'crop' || frame === undefined || frame === null) return centered;
  if (!isRecord(frame)) invalidFrame();

  const requested = {
    x: finiteCoordinate(frame.x),
    y: finiteCoordinate(frame.y),
    width: finiteCoordinate(frame.width),
    height: finiteCoordinate(frame.height),
  };
  if (
    requested.x < 0 ||
    requested.y < 0 ||
    requested.width < MINIMUM_FRAME_EDGE ||
    requested.height < MINIMUM_FRAME_EDGE ||
    requested.x + requested.width > sourceWidth ||
    requested.y + requested.height > sourceHeight
  ) invalidFrame();

  const ratioError = Math.abs(requested.width / requested.height - targetRatio) / targetRatio;
  if (ratioError > RATIO_TOLERANCE) invalidFrame();

  const left = Math.round(requested.x);
  const top = Math.round(requested.y);
  const right = Math.round(requested.x + requested.width);
  const bottom = Math.round(requested.y + requested.height);
  const normalized = {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
  if (
    normalized.width < MINIMUM_FRAME_EDGE ||
    normalized.height < MINIMUM_FRAME_EDGE ||
    normalized.x + normalized.width > sourceWidth ||
    normalized.y + normalized.height > sourceHeight
  ) invalidFrame();
  return normalized;
}
