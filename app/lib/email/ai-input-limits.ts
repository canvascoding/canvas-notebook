import 'server-only';

const MAX_INSTRUCTION_CHARS = 8_000;
const MAX_CURRENT_BODY_CHARS = 30_000;
const MAX_CURRENT_BODY_HTML_CHARS = 60_000;
const MAX_SUBJECT_CHARS = 1_000;
const MAX_RECIPIENT_CONTEXT_CHARS = 8_000;
const MAX_RECIPIENTS = 100;
const MAX_CONTEXT_FILES = 20;
const MAX_CONTEXT_FILE_PATH_CHARS = 1_024;
const MAX_CONTEXT_FILE_NAME_CHARS = 512;

function assertOptionalText(value: unknown, label: string, maxChars: number): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') {
    throw new Error(`${label} must be text.`);
  }
  if (value.length > maxChars) {
    throw new Error(`${label} exceeds the ${maxChars}-character Email AI limit.`);
  }
}

function recipientContextLength(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + String(entry ?? '').length, 0);
  }
  return String(value ?? '').length;
}

export function assertEmailAiInstruction(instruction: unknown): void {
  assertOptionalText(instruction, 'Email AI instruction', MAX_INSTRUCTION_CHARS);
}

export function assertEmailAiComposeInput(input: {
  cc?: unknown;
  contextFiles?: unknown;
  currentBody?: unknown;
  currentBodyHtml?: unknown;
  instruction?: unknown;
  subject?: unknown;
  to?: unknown;
}): void {
  assertEmailAiInstruction(input.instruction);
  assertOptionalText(input.currentBody, 'Current email body', MAX_CURRENT_BODY_CHARS);
  assertOptionalText(input.currentBodyHtml, 'Current email HTML', MAX_CURRENT_BODY_HTML_CHARS);
  assertOptionalText(input.subject, 'Email subject', MAX_SUBJECT_CHARS);
  if (
    (Array.isArray(input.to) && input.to.length > MAX_RECIPIENTS)
    || (Array.isArray(input.cc) && input.cc.length > MAX_RECIPIENTS)
  ) {
    throw new Error(`Email AI supports at most ${MAX_RECIPIENTS} recipients per field.`);
  }
  if (
    recipientContextLength(input.to) > MAX_RECIPIENT_CONTEXT_CHARS
    || recipientContextLength(input.cc) > MAX_RECIPIENT_CONTEXT_CHARS
  ) {
    throw new Error(`Email recipients exceed the ${MAX_RECIPIENT_CONTEXT_CHARS}-character Email AI limit.`);
  }

  if (input.contextFiles === undefined) return;
  if (!Array.isArray(input.contextFiles)) {
    throw new Error('Email contextFiles must be a list.');
  }
  if (input.contextFiles.length > MAX_CONTEXT_FILES) {
    throw new Error(`Email AI supports at most ${MAX_CONTEXT_FILES} selected context files.`);
  }
  for (const entry of input.contextFiles) {
    const record = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : null;
    const filePath = typeof record?.path === 'string' ? record.path.trim() : '';
    if (!filePath || filePath.length > MAX_CONTEXT_FILE_PATH_CHARS) {
      throw new Error(`Each Email AI context file needs a path up to ${MAX_CONTEXT_FILE_PATH_CHARS} characters.`);
    }
    if (record?.name !== undefined && (typeof record.name !== 'string' || record.name.length > MAX_CONTEXT_FILE_NAME_CHARS)) {
      throw new Error(`Each Email AI context filename must be text up to ${MAX_CONTEXT_FILE_NAME_CHARS} characters.`);
    }
  }
}
