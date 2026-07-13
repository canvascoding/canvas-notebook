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

let smtpTransportFactory: SmtpTransportFactory = (options) => nodemailer.createTransport(options);

export function setSmtpTransportFactoryForTests(factory: SmtpTransportFactory | null): void {
  smtpTransportFactory = factory || ((options) => nodemailer.createTransport(options));
}

export function smtpTransportOptions(config: SmtpTransportConfig): SMTPTransport.Options {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.username,
      pass: config.password,
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

export function createSmtpTransport(config: SmtpTransportConfig): nodemailer.Transporter {
  return smtpTransportFactory(smtpTransportOptions(config));
}
