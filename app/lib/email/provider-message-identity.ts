import {
  createImapMessageReference,
  parseImapMessageReference,
} from '@/app/lib/email/imap-service';

const IMAP_MESSAGE_REFERENCE_PREFIX = 'imap:v1:';
const MAX_IMAP_UINT32 = BigInt('4294967295');

export type ProviderMessageIdentityInput = {
  id: string;
  uid?: string | number;
  uidValidity?: string | number;
  folder?: string;
};

export type ProviderMessageIdentity = {
  canonicalId: string;
  folder: string;
  isImap: boolean;
  legacyId: string | null;
  uid: string | null;
  uidValidity: string | null;
};

function normalizeFolder(value: unknown): string {
  const normalized = (typeof value === 'string' ? value : 'INBOX')
    .trim()
    .replace(/[\u0000\r\n]/gu, '')
    .slice(0, 240);
  return normalized || 'INBOX';
}

function positiveUint32Text(value: unknown): string | null {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === 'string' ? value.trim() : '';
  if (!/^[1-9]\d*$/u.test(normalized)) return null;
  return BigInt(normalized) <= MAX_IMAP_UINT32 ? normalized : null;
}

/**
 * Resolves the durable provider identity used by poller idempotency. IMAP
 * identities include folder, UIDVALIDITY and UID; the raw UID is returned only
 * as a migration alias for records written before opaque references existed.
 */
export function resolveProviderMessageIdentity(input: ProviderMessageIdentityInput): ProviderMessageIdentity {
  const id = input.id.trim();
  if (!id) throw new Error('Provider message ID is required.');
  const requestedFolder = normalizeFolder(input.folder);
  const listedUid = positiveUint32Text(input.uid);
  const listedUidValidity = positiveUint32Text(input.uidValidity);
  const hasListedUid = input.uid !== undefined
    && input.uid !== null
    && String(input.uid).trim() !== '';
  const hasListedUidValidity = input.uidValidity !== undefined
    && input.uidValidity !== null
    && String(input.uidValidity).trim() !== '';

  if (id.startsWith(IMAP_MESSAGE_REFERENCE_PREFIX)) {
    if ((hasListedUid && !listedUid) || (hasListedUidValidity && !listedUidValidity)) {
      throw new Error('Invalid IMAP UID or UIDVALIDITY.');
    }
    const parsedReference = parseImapMessageReference(id);
    const parsedUid = positiveUint32Text(parsedReference.uid);
    const parsedUidValidity = positiveUint32Text(parsedReference.uidValidity);
    if (parsedReference.version !== 1 || !parsedUid || !parsedUidValidity) {
      throw new Error('Invalid IMAP message ID.');
    }
    if (
      (listedUid && listedUid !== parsedUid)
      || (listedUidValidity && listedUidValidity !== parsedUidValidity)
      || (input.folder && requestedFolder !== parsedReference.folder)
    ) {
      throw new Error('Inconsistent IMAP message identity.');
    }
    return {
      canonicalId: createImapMessageReference(parsedReference.folder, parsedUidValidity, Number(parsedUid)),
      folder: parsedReference.folder,
      isImap: true,
      legacyId: parsedUid,
      uid: parsedUid,
      uidValidity: parsedUidValidity,
    };
  }

  if (hasListedUidValidity && (!listedUid || !listedUidValidity)) {
    throw new Error('Invalid IMAP UID or UIDVALIDITY.');
  }
  if (listedUid && listedUidValidity) {
    return {
      canonicalId: createImapMessageReference(requestedFolder, listedUidValidity, Number(listedUid)),
      folder: requestedFolder,
      isImap: true,
      legacyId: listedUid,
      uid: listedUid,
      uidValidity: listedUidValidity,
    };
  }

  return {
    canonicalId: id,
    folder: requestedFolder,
    isImap: false,
    legacyId: null,
    uid: listedUid,
    uidValidity: listedUidValidity,
  };
}
