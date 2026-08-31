import 'server-only';

import path from 'node:path';

import {
  EMAIL_ATTACHMENT_MAX_FILES,
  EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES,
  estimateEmailAttachmentTransferBytes,
  inferEmailAttachmentMimeType,
  isMarkdownEmailAttachmentName,
  markdownEmailAttachmentPdfName,
  type EmailAttachmentDisposition,
  type EmailAttachmentDeliveryFormat,
  type EmailAttachmentInput,
  type EmailAttachmentSource,
} from '@/app/lib/email/attachment-types';
import {
  getFileStats as getWorkspaceFileStats,
  readFile as readWorkspaceFile,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import {
  getFileInfo as getUploadedFileInfo,
  readFile as readUploadedFile,
  saveUploadBuffer,
} from '@/app/lib/filesystem/upload-handler';
import { getAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';

export type ResolvedEmailAttachment = {
  content: Buffer;
  mimeType: string;
  name: string;
  size: number;
  source: EmailAttachmentSource;
  contentId?: string;
  disposition: EmailAttachmentDisposition;
};

type EmailAttachmentMetadata = Omit<ResolvedEmailAttachment, 'content'> & {
  deliveryFormat: EmailAttachmentDeliveryFormat;
  input: EmailAttachmentInput;
};

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanFileName(value: string): string {
  const base = path.basename(value.replace(/\\/g, '/')).replace(/[\r\n"]/g, '_').trim();
  return base || 'attachment';
}

function cleanContentId(value: unknown): string | undefined {
  const contentId = cleanString(value)
    .replace(/^cid:/iu, '')
    .replace(/^<|>$/gu, '')
    .replace(/[\r\n"<>]/gu, '')
    .trim();

  if (!contentId || /\s/u.test(contentId)) return undefined;
  return contentId.slice(0, 180);
}

function normalizeAttachmentDisposition(record: Record<string, unknown>, contentId?: string): EmailAttachmentDisposition {
  return record.disposition === 'inline' && contentId ? 'inline' : 'attachment';
}

export function normalizeEmailAttachmentInputs(value: unknown): EmailAttachmentInput[] {
  if (!Array.isArray(value)) return [];
  const output: EmailAttachmentInput[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const source = record.source === 'workspace' || record.source === 'upload' ? record.source : null;
    if (!source) continue;
    const contentId = cleanContentId(record.contentId);

    const normalized: EmailAttachmentInput = {
      source,
      contentId,
      disposition: normalizeAttachmentDisposition(record, contentId),
      name: cleanString(record.name) || undefined,
      mimeType: cleanString(record.mimeType) || undefined,
      size: typeof record.size === 'number' && Number.isFinite(record.size) && record.size >= 0 ? record.size : undefined,
      path: cleanString(record.path) || undefined,
      uploadId: cleanString(record.uploadId) || undefined,
      deliveryFormat: record.deliveryFormat === 'pdf' || record.deliveryFormat === 'original' ? record.deliveryFormat : undefined,
    };
    output.push(normalized);
  }

  return output;
}

function assertAttachmentLimit(metadata: Array<{ size: number }>) {
  if (metadata.length > EMAIL_ATTACHMENT_MAX_FILES) {
    throw new Error(`Maximum ${EMAIL_ATTACHMENT_MAX_FILES} attachments per email.`);
  }

  const total = metadata.reduce((sum, attachment) => sum + estimateEmailAttachmentTransferBytes(attachment.size), 0);
  if (total > EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES) {
    throw new Error('Email attachments exceed the 20 MB total limit.');
  }
}

function currentWorkspaceFileOptions(): WorkspaceFileOperationOptions | undefined {
  const context = getAgentExecutionContext();
  if (!context) return undefined;

  return {
    workspace: {
      workspaceId: context.workspaceId,
      workspaceType: context.workspaceType,
      displayName: context.workspaceName ?? undefined,
      rootPath: context.workspaceRoot,
      rootRelativePath: context.workspaceRootRelativePath ?? undefined,
      organizationId: context.organizationId,
      customerId: context.customerId,
      projectId: context.projectId,
      actor: { userId: context.userId, role: 'member' },
      permissions: {
        canRead: true,
        canWrite: context.canWrite,
        canDelete: context.canDelete,
        canCreatePublicLinks: context.canShare,
        canManageWorkspace: false,
        canRunAgent: true,
      },
      legacy: context.legacy,
    },
  };
}

async function resolveWorkspaceAttachmentMetadata(
  input: EmailAttachmentInput,
  fileOptions?: WorkspaceFileOperationOptions,
): Promise<EmailAttachmentMetadata> {
  const workspacePath = cleanString(input.path);
  if (!workspacePath) throw new Error('Workspace attachment path is required.');
  const stats = await getWorkspaceFileStats(workspacePath, fileOptions);
  if (!stats.isFile) throw new Error(`Attachment "${workspacePath}" is not a file.`);
  const name = cleanFileName(input.name || workspacePath);
  const wantsPdf = input.deliveryFormat === 'pdf';
  if (wantsPdf) {
    const markdownName = isMarkdownEmailAttachmentName(name) ? name : path.basename(workspacePath);
    if (!isMarkdownEmailAttachmentName(workspacePath) && !isMarkdownEmailAttachmentName(markdownName)) {
      throw new Error(`Attachment "${name}" cannot be sent as PDF because it is not a markdown file.`);
    }
    return {
      deliveryFormat: 'pdf',
      input: { ...input, path: workspacePath },
      disposition: 'attachment',
      mimeType: 'application/pdf',
      name: cleanFileName(markdownEmailAttachmentPdfName(markdownName)),
      size: stats.size,
      source: 'workspace',
    };
  }

  return {
    deliveryFormat: 'original',
    input: { ...input, path: workspacePath },
    contentId: input.contentId,
    disposition: input.disposition === 'inline' && input.contentId ? 'inline' : 'attachment',
    mimeType: inferEmailAttachmentMimeType(name, input.mimeType),
    name,
    size: stats.size,
    source: 'workspace',
  };
}

async function resolveUploadAttachmentMetadata(input: EmailAttachmentInput): Promise<EmailAttachmentMetadata> {
  const uploadId = cleanString(input.uploadId);
  if (!uploadId) throw new Error('Uploaded attachment id is required.');
  const info = await getUploadedFileInfo(uploadId);
  if (!info) throw new Error(`Uploaded attachment "${uploadId}" was not found.`);
  const name = cleanFileName(input.name || info.originalName || uploadId);
  if (input.deliveryFormat === 'pdf') {
    throw new Error(`Uploaded attachment "${name}" cannot be sent as PDF. Attach a workspace markdown file to use PDF conversion.`);
  }

  return {
    deliveryFormat: 'original',
    input: { ...input, uploadId },
    contentId: input.contentId,
    disposition: input.disposition === 'inline' && input.contentId ? 'inline' : 'attachment',
    mimeType: inferEmailAttachmentMimeType(name, input.mimeType || info.mimeType),
    name,
    size: info.size,
    source: 'upload',
  };
}

async function resolveAttachmentMetadata(
  input: EmailAttachmentInput,
  fileOptions?: WorkspaceFileOperationOptions,
): Promise<EmailAttachmentMetadata> {
  if (input.source === 'workspace') return resolveWorkspaceAttachmentMetadata(input, fileOptions);
  return resolveUploadAttachmentMetadata(input);
}

async function readAttachmentContent(
  metadata: EmailAttachmentMetadata,
  fileOptions?: WorkspaceFileOperationOptions,
): Promise<ResolvedEmailAttachment> {
  const content = metadata.deliveryFormat === 'pdf'
    ? await renderWorkspaceMarkdownPdf(metadata, fileOptions)
    : metadata.source === 'workspace'
      ? await readWorkspaceFile(metadata.input.path || '', fileOptions)
      : await readUploadedFile(metadata.input.uploadId || '');

  if (!content) throw new Error(`Attachment "${metadata.name}" could not be read.`);
  if (estimateEmailAttachmentTransferBytes(content.length) > EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES) {
    throw new Error(`Attachment "${metadata.name}" exceeds the 20 MB total limit.`);
  }

  return {
    content,
    contentId: metadata.contentId,
    disposition: metadata.disposition,
    mimeType: metadata.mimeType,
    name: metadata.name,
    size: content.length,
    source: metadata.source,
  };
}

async function renderWorkspaceMarkdownPdf(
  metadata: EmailAttachmentMetadata,
  fileOptions?: WorkspaceFileOperationOptions,
): Promise<Buffer> {
  if (metadata.source !== 'workspace' || !metadata.input.path) {
    throw new Error(`Attachment "${metadata.name}" cannot be rendered as PDF.`);
  }

  const { renderMarkdownWorkspaceFileToPdf } = await import('@/app/lib/pdf/markdown-pdf');
  return renderMarkdownWorkspaceFileToPdf(metadata.input.path, fileOptions);
}

export async function resolveEmailAttachments(value: unknown): Promise<ResolvedEmailAttachment[]> {
  const inputs = normalizeEmailAttachmentInputs(value);
  if (inputs.length === 0) return [];
  const fileOptions = currentWorkspaceFileOptions();

  const metadata = await Promise.all(inputs.map((input) => resolveAttachmentMetadata(input, fileOptions)));
  assertAttachmentLimit(metadata);

  const resolved = await Promise.all(metadata.map((attachment) => readAttachmentContent(attachment, fileOptions)));
  assertAttachmentLimit(resolved);
  return resolved;
}

/**
 * Creates stable uploaded copies of workspace files selected by an agent.
 *
 * Outbox drafts can be reviewed and sent after the agent execution context is
 * gone, so keeping workspace paths would either make the attachment depend on
 * a later workspace lookup or risk attaching a changed file. A copy makes the
 * reviewed artifact and the eventual delivery identical.
 */
export async function snapshotAgentWorkspaceEmailAttachments(
  value: unknown,
  userId: string,
): Promise<EmailAttachmentInput[]> {
  const inputs = normalizeEmailAttachmentInputs(value);
  if (inputs.length === 0) return [];

  const context = getAgentExecutionContext();
  if (!context || context.userId !== userId) {
    throw new Error('Email agent attachments require an active agent workspace.');
  }

  if (inputs.some((attachment) => attachment.source !== 'workspace')) {
    throw new Error('Email agents can attach workspace files only.');
  }

  const resolved = await resolveEmailAttachments(inputs);
  return Promise.all(resolved.map(async (attachment) => {
    const uploaded = await saveUploadBuffer(attachment.content, attachment.name, attachment.mimeType, {
      maxBytes: EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES,
      ownerUserId: userId,
      workspaceId: context.workspaceId,
    });
    return {
      source: 'upload' as const,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      uploadId: uploaded.id,
    };
  }));
}
