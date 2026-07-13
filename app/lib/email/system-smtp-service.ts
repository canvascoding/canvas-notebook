import 'server-only';

import { normalizeEmailCustomHeaders, type EmailCustomHeaders } from '@/app/lib/email/headers';
import { getSystemSmtpConfiguration } from '@/app/lib/email/system-smtp-config';
import { createSmtpTransport } from '@/app/lib/email/smtp-transport';

export type SystemSmtpEmailInput = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  headers?: EmailCustomHeaders;
};

async function requireSystemSmtpConfiguration() {
  const configuration = await getSystemSmtpConfiguration();
  if (!configuration) throw new Error('System SMTP is not configured.');
  return configuration;
}

export async function verifySystemSmtpConnection(): Promise<{ host: string; port: number; secure: boolean }> {
  const configuration = await requireSystemSmtpConfiguration();
  const transporter = createSmtpTransport(configuration.smtp);
  try {
    await transporter.verify();
    return {
      host: configuration.smtp.host,
      port: configuration.smtp.port,
      secure: configuration.smtp.secure,
    };
  } finally {
    transporter.close();
  }
}

export async function sendSystemSmtpEmail(input: SystemSmtpEmailInput): Promise<{ messageId: string | null }> {
  const configuration = await requireSystemSmtpConfiguration();
  const transporter = createSmtpTransport(configuration.smtp);
  try {
    const response = await transporter.sendMail({
      from: configuration.from.name
        ? { name: configuration.from.name, address: configuration.from.address }
        : configuration.from.address,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      replyTo: configuration.replyTo || undefined,
      subject: input.subject,
      headers: normalizeEmailCustomHeaders(input.headers),
      ...(input.isHtml ? { html: input.body } : { text: input.body }),
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return { messageId: typeof response.messageId === 'string' && response.messageId.trim() ? response.messageId : null };
  } finally {
    transporter.close();
  }
}
