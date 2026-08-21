import 'server-only';

import { getManagedSystemEmailAvailability, sendManagedSystemEmail } from '@/app/lib/email/managed-system-email-client';
import { sendSystemSmtpEmail } from '@/app/lib/email/system-smtp-service';
import { getSystemSmtpConfigurationStatus } from '@/app/lib/email/system-smtp-config';
import { classifySmtpError, normalizeSmtpEmailAddress } from '@/app/lib/email/smtp-configuration';

export class SystemEmailAdminError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = 'SystemEmailAdminError';
  }
}

export function systemEmailErrorDetails(error: unknown): { code: string; status: number; message: string } {
  if (error instanceof SystemEmailAdminError) return { code: error.code, status: error.status, message: error.message };
  const classified = classifySmtpError(error);
  return { ...classified, message: 'The system email provider could not complete this request.' };
}

export async function sendSystemEmailTestMessage(recipient: unknown): Promise<{
  mode: 'managed' | 'local';
  recipientMasked: string;
  sentAt: string;
  messageAccepted: boolean;
}> {
  const address = normalizeSmtpEmailAddress(recipient, 'Administrator email address');
  const status = await getSystemSmtpConfigurationStatus();
  const sentAt = new Date().toISOString();
  const body = `This is a Canvas Notebook system email test sent at ${sentAt}.`;
  if (status.deliveryMode === 'disabled') {
    throw new SystemEmailAdminError('SYSTEM_EMAIL_MODE_UNAVAILABLE', 409, 'System email is disabled.');
  }
  try {
    if (status.deliveryMode === 'managed') {
      const managed = await getManagedSystemEmailAvailability();
      if (!managed.available) {
        throw new SystemEmailAdminError('SYSTEM_EMAIL_MODE_UNAVAILABLE', 409, 'Managed system email is not available.');
      }
      await sendManagedSystemEmail({
        purpose: 'automation_alert',
        to: [address],
        subject: 'Canvas Notebook system email test',
        body,
        idempotencyKey: `system-email-test:${address}:${sentAt}`,
      });
      return { mode: 'managed', recipientMasked: maskEmail(address), sentAt, messageAccepted: true };
    }
    if (!status.configured) {
      throw new SystemEmailAdminError('SYSTEM_EMAIL_CONFIG_MISSING', 409, 'Complete the local SMTP configuration before sending a test email.');
    }
    await sendSystemSmtpEmail({ to: [address], subject: 'Canvas Notebook system email test', body });
    return { mode: 'local', recipientMasked: maskEmail(address), sentAt, messageAccepted: true };
  } catch (error) {
    if (error instanceof SystemEmailAdminError) throw error;
    const details = systemEmailErrorDetails(error);
    throw new SystemEmailAdminError(details.code, details.status, details.message);
  }
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
