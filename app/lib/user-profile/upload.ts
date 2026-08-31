import 'server-only';

import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';

import { USER_PROFILE_AVATAR_MAX_STORED_BYTES } from './storage';

export const USER_PROFILE_AVATAR_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const USER_PROFILE_AVATAR_SIZE_PX = 256;

const USER_PROFILE_AVATAR_MAX_INPUT_PIXELS = 20_000_000;
const ALLOWED_AVATAR_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export class UserProfileUploadError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'UserProfileUploadError';
  }
}

async function encodeAvatar(buffer: Buffer, quality: number): Promise<Buffer> {
  return sharp(buffer, {
    failOn: 'error',
    limitInputPixels: USER_PROFILE_AVATAR_MAX_INPUT_PIXELS,
    pages: 1,
  })
    .rotate()
    .resize(USER_PROFILE_AVATAR_SIZE_PX, USER_PROFILE_AVATAR_SIZE_PX, {
      fit: 'cover',
      position: 'centre',
    })
    .webp({ quality, alphaQuality: 92, effort: 4 })
    .toBuffer();
}

export async function normalizeUserProfileUpload(buffer: Buffer): Promise<Buffer> {
  if (buffer.length === 0) {
    throw new UserProfileUploadError('The profile image is empty.');
  }
  if (buffer.length > USER_PROFILE_AVATAR_MAX_UPLOAD_BYTES) {
    throw new UserProfileUploadError('Profile image is too large. Maximum size is 5 MB.', 413);
  }

  const detected = await fileTypeFromBuffer(buffer).catch(() => undefined);
  if (!detected || !ALLOWED_AVATAR_MIME_TYPES.has(detected.mime)) {
    throw new UserProfileUploadError('Unsupported image format. Use PNG, JPG, WebP, HEIC, or HEIF.');
  }

  try {
    const metadata = await sharp(buffer, {
      failOn: 'error',
      limitInputPixels: USER_PROFILE_AVATAR_MAX_INPUT_PIXELS,
      pages: 1,
    }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new UserProfileUploadError('The image dimensions could not be determined.');
    }
    if ((metadata.pages ?? 1) > 1) {
      throw new UserProfileUploadError('Animated or multi-page profile images are not supported.');
    }
    if (metadata.width * metadata.height > USER_PROFILE_AVATAR_MAX_INPUT_PIXELS) {
      throw new UserProfileUploadError('Profile image dimensions are too large.');
    }

    let output = await encodeAvatar(buffer, 88);
    if (output.length > USER_PROFILE_AVATAR_MAX_STORED_BYTES) {
      output = await encodeAvatar(buffer, 74);
    }
    if (output.length > USER_PROFILE_AVATAR_MAX_STORED_BYTES) {
      throw new UserProfileUploadError('The processed profile image is still too large.');
    }
    return output;
  } catch (error) {
    if (error instanceof UserProfileUploadError) throw error;
    throw new UserProfileUploadError('The uploaded file is not a valid supported image.');
  }
}
