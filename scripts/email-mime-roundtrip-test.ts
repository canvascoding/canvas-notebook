import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';

async function testMimeRoundTrip(): Promise<void> {
  // Generate the real outgoing MIME message in memory; no SMTP delivery.
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  try {
    const content = Buffer.from('Attachment with Grüße and Unicode ✓', 'utf8');
    const sent = await transport.sendMail({
      from: 'Canvas Test <sender@example.test>',
      to: 'reader@example.test',
      subject: 'Grüße ✓',
      text: 'Hello Canvas.',
      html: '<p>Hello <strong>Canvas</strong>.</p>',
      attachments: [{ filename: 'übersicht.txt', content, contentType: 'text/plain; charset=utf-8' }],
    });
    const parsed = await simpleParser(sent.message);
    assert.equal(parsed.subject, 'Grüße ✓');
    assert.match(parsed.text || '', /Hello Canvas\./u);
    assert.match(String(parsed.html), /<strong>Canvas<\/strong>/u);
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0].filename, 'übersicht.txt');
    assert.deepEqual(parsed.attachments[0].content, content);

    const injection = await transport.sendMail({
      from: 'sender@example.test', to: 'reader@example.test',
      subject: 'Security\r\nBcc: hidden@example.test', text: 'Header boundary fixture',
    });
    const protectedMessage = await simpleParser(injection.message);
    assert.equal(protectedMessage.headers.has('bcc'), false);
    assert.deepEqual(injection.envelope.to, ['reader@example.test']);
    console.log('Nodemailer/mailparser: real MIME generation/parsing, Unicode attachment and header isolation passed');
  } finally {
    transport.close();
  }
}

testMimeRoundTrip().catch(error => { console.error(error); process.exitCode = 1; });
