import 'server-only';

import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

export type SmtpTransportConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
};

export type SmtpTransportFactory = (options: SMTPTransport.Options) => nodemailer.Transporter;

export const SMTP_CONNECTION_TIMEOUT_MS = 15_000;
export const SMTP_GREETING_TIMEOUT_MS = 15_000;
export const SMTP_SOCKET_TIMEOUT_MS = 30_000;

let smtpTransportFactory: SmtpTransportFactory = (options) => nodemailer.createTransport(options);

export function setSmtpTransportFactoryForTests(factory: SmtpTransportFactory | null): void {
  smtpTransportFactory = factory || ((options) => nodemailer.createTransport(options));
}

export function smtpTransportOptions(config: SmtpTransportConfig): SMTPTransport.Options {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: {
      user: config.username,
      pass: config.password,
    },
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

export function createSmtpTransport(config: SmtpTransportConfig): nodemailer.Transporter {
  return smtpTransportFactory(smtpTransportOptions(config));
}
