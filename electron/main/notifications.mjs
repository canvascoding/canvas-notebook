import { Notification } from 'electron';

const MAX_TITLE_LENGTH = 80;
const MAX_BODY_LENGTH = 240;
const DEDUPE_WINDOW_MS = 10_000;
const deliveredNotifications = new Map();

function normalizeText(value, maxLength) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  if (!text) return '';
  if (text.length <= maxLength) return text;

  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizePayload(value) {
  const source = value && typeof value === 'object' ? value : {};
  const sessionId = normalizeText(source.sessionId, 120);
  const title = normalizeText(source.sessionTitle || 'Canvas Notebook', MAX_TITLE_LENGTH);
  const preview = normalizeText(source.messagePreview, MAX_BODY_LENGTH);
  const lastMessageAt = normalizeText(source.lastMessageAt, 80);
  const notificationType = normalizeText(source.notificationType || 'new_response', 40);

  if (!sessionId) {
    throw new Error('sessionId is required for chat notifications.');
  }

  return {
    sessionId,
    sessionTitle: title || 'Canvas Notebook',
    messagePreview: preview,
    lastMessageAt,
    notificationType,
  };
}

function rememberNotification(key) {
  const now = Date.now();
  const existing = deliveredNotifications.get(key);

  if (existing && now - existing < DEDUPE_WINDOW_MS) {
    return false;
  }

  deliveredNotifications.set(key, now);

  for (const [storedKey, deliveredAt] of deliveredNotifications) {
    if (now - deliveredAt > DEDUPE_WINDOW_MS) {
      deliveredNotifications.delete(storedKey);
    }
  }

  return true;
}

function restoreAndOpenTarget(browserWindow, targetUrl) {
  if (!browserWindow || browserWindow.isDestroyed()) return;

  if (browserWindow.isMinimized()) {
    browserWindow.restore();
  }

  browserWindow.show();
  browserWindow.focus();

  if (targetUrl) {
    void browserWindow.loadURL(targetUrl).catch(error => {
      console.error('[electron] Failed to open notification target:', error);
    });
  }
}

export function showChatNotification(options) {
  const {
    app,
    browserWindow,
    iconPath,
    payload,
    settings,
    targetUrl,
  } = options;

  if (!Notification.isSupported()) {
    return { ok: false, skippedReason: 'unsupported' };
  }

  const notificationSettings = settings && typeof settings === 'object' ? settings : {};
  if (notificationSettings.enabled === false) {
    return { ok: false, skippedReason: 'disabled' };
  }

  const detail = normalizePayload(payload);
  const key = `${detail.sessionId}:${detail.lastMessageAt || detail.messagePreview || detail.notificationType}`;

  if (!rememberNotification(key)) {
    return { ok: false, skippedReason: 'duplicate' };
  }

  const body = notificationSettings.showPreview === false
    ? 'New chat response ready.'
    : detail.messagePreview || 'New chat response ready.';

  const notification = new Notification({
    title: detail.sessionTitle,
    body,
    silent: notificationSettings.sound === false,
    icon: iconPath,
  });

  notification.on('click', () => {
    restoreAndOpenTarget(browserWindow, targetUrl);
  });

  notification.show();

  if (process.platform === 'darwin' && app?.dock) {
    app.dock.bounce('informational');
  }

  return { ok: true };
}
