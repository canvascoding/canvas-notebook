import assert from 'node:assert/strict';

import { normalizeNotificationPreview } from '../app/lib/chat/notification-preview';

const markdownPreview = normalizeNotificationPreview('Intro\n\n## Ergebnis\n\nDas ist **wichtig**.');
assert.equal(markdownPreview, 'Intro\n\n## Ergebnis\n\nDas ist **wichtig**.');

const windowsLineEndings = normalizeNotificationPreview('Intro\r\n\r\n## Ergebnis\r\nText');
assert.equal(windowsLineEndings, 'Intro\n\n## Ergebnis\nText');

const compactWhitespace = normalizeNotificationPreview('  ##   Ergebnis   \n\n  Text   mit    Abstand  ');
assert.equal(compactWhitespace, '## Ergebnis\n\nText mit Abstand');

const truncated = normalizeNotificationPreview('## Ergebnis\n' + 'a'.repeat(20), 16);
assert.equal(truncated, '## Ergebnis\naaa…');

console.log('Notification preview markdown test passed.');
