import fs from 'node:fs';
import path from 'node:path';

const CONFIG_FILE_NAME = 'desktop-config.json';

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  serverUrl: null,
  window: {
    width: 1280,
    height: 860,
    x: null,
    y: null,
    maximized: false,
  },
  notifications: {
    enabled: true,
    showPreview: true,
    sound: true,
  },
});

function getConfigPath(app) {
  return path.join(app.getPath('userData'), CONFIG_FILE_NAME);
}

function normalizeWindowState(value) {
  const source = value && typeof value === 'object' ? value : {};

  return {
    width: Number.isFinite(source.width) ? Math.max(960, Math.round(source.width)) : DEFAULT_CONFIG.window.width,
    height: Number.isFinite(source.height) ? Math.max(680, Math.round(source.height)) : DEFAULT_CONFIG.window.height,
    x: Number.isFinite(source.x) ? Math.round(source.x) : null,
    y: Number.isFinite(source.y) ? Math.round(source.y) : null,
    maximized: source.maximized === true,
  };
}

function normalizeConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  const serverUrl = typeof source.serverUrl === 'string' && source.serverUrl.trim()
    ? source.serverUrl.trim()
    : null;

  return {
    version: 1,
    serverUrl,
    window: normalizeWindowState(source.window),
    notifications: normalizeNotificationSettings(source.notifications),
  };
}

function normalizeNotificationSettings(value) {
  const source = value && typeof value === 'object' ? value : {};

  return {
    enabled: source.enabled !== false,
    showPreview: source.showPreview !== false,
    sound: source.sound !== false,
  };
}

function normalizeNotificationSettingsPatch(value) {
  const source = value && typeof value === 'object' ? value : {};
  const settings = {};

  if (typeof source.enabled === 'boolean') {
    settings.enabled = source.enabled;
  }

  if (typeof source.showPreview === 'boolean') {
    settings.showPreview = source.showPreview;
  }

  if (typeof source.sound === 'boolean') {
    settings.sound = source.sound;
  }

  return settings;
}

export function readDesktopConfig(app) {
  const filePath = getConfigPath(app);

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[electron] Failed to read ${filePath}:`, error);
    }

    return normalizeConfig(DEFAULT_CONFIG);
  }
}

export function writeDesktopConfig(app, nextConfig) {
  const filePath = getConfigPath(app);
  const config = normalizeConfig(nextConfig);
  const tempFilePath = `${filePath}.tmp`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempFilePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tempFilePath, filePath);

  return config;
}

export function updateDesktopConfig(app, updater) {
  const current = readDesktopConfig(app);
  const next = updater(current);
  return writeDesktopConfig(app, next);
}

export function setServerUrl(app, serverUrl) {
  return updateDesktopConfig(app, current => ({
    ...current,
    serverUrl,
  }));
}

export function clearServerUrl(app) {
  return updateDesktopConfig(app, current => ({
    ...current,
    serverUrl: null,
  }));
}

export function setNotificationSettings(app, settings) {
  return updateDesktopConfig(app, current => ({
    ...current,
    notifications: {
      ...current.notifications,
      ...normalizeNotificationSettingsPatch(settings),
    },
  }));
}

export function saveWindowState(app, browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) return readDesktopConfig(app);

  const bounds = browserWindow.getBounds();

  return updateDesktopConfig(app, current => ({
    ...current,
    window: {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: browserWindow.isMaximized(),
    },
  }));
}
