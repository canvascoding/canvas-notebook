import assert from 'node:assert/strict';
import Module from 'node:module';
const internal = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const original = internal._load;
internal._load = (request, parent, isMain) => {
  if (['server-only', '@/app/lib/db', '@/app/lib/email/account-store', '@/app/lib/email/draft-store', '@/app/lib/email/attachments', '@/app/lib/email/imap-service', '@/app/lib/email/smtp-transport'].includes(request)) return {};
  return original(request, parent, isMain);
};
async function main() {
  try {
    const { normalizeSmtpAccountInput } = await import('../app/lib/email/smtp-service');
    const smtp = { host: 'smtp.example.test', port: 587, secure: false, username: 'mail', password: 'smtp-secret' };
    const imap = { host: 'imap.example.test', port: 993, secure: true, username: 'mail', password: 'imap-secret' };
    const secret = { authType: 'smtp_imap' as const, smtp, imap };
    const input = { emailAddress: 'mail@example.test', smtpHost: smtp.host, smtpPort: smtp.port, smtpSecure: false, smtpUsername: smtp.username, smtpPassword: '', imapHost: imap.host, imapPort: imap.port, imapSecure: true, imapUsername: imap.username, imapPassword: '' };
    assert.equal(normalizeSmtpAccountInput(input, secret).secret.imap?.password, 'imap-secret', 'An unchanged connection keeps its password');
    const disabled = normalizeSmtpAccountInput({ ...input, imapHost: '', imapPort: '', imapUsername: '', imapPassword: '' }, secret);
    assert.equal(disabled.secret.imap, undefined, 'Cleared IMAP fields switch to send-only');
    assert.equal(disabled.secret.smtp.password, 'smtp-secret', 'Disabling IMAP preserves SMTP credentials');
    assert.throws(() => normalizeSmtpAccountInput({ ...input, imapHost: '' }, secret), /all required/, 'Partial IMAP configuration must still be rejected');
    assert.throws(() => normalizeSmtpAccountInput(input, { authType: 'smtp_imap', smtp }), /all required/, 'A new IMAP connection needs a password');
    assert.equal(normalizeSmtpAccountInput({ ...input, imapPassword: 'new-password' }, { authType: 'smtp_imap', smtp }).secret.imap?.password, 'new-password');
    console.log('SMTP normalization passed: disable/re-enable IMAP, preserve passwords, reject partial configuration.');
  } finally { internal._load = original; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
