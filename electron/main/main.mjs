import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  clearServerUrl,
  readDesktopConfig,
  saveWindowState,
  setServerUrl,
} from './config-store.mjs';
import { checkServerHealth } from './health-check.mjs';
import { createAppMenu } from './menu.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON_PATH = path.join(__dirname, '../assets/icon.png');
const PRELOAD_PATH = path.join(__dirname, '../preload/index.cjs');
const SETUP_FILE_PATH = path.join(__dirname, '../renderer/setup.html');
const SETUP_FILE_URL = pathToFileURL(SETUP_FILE_PATH).href;

let mainWindow = null;
let loadingSetup = false;

app.setName('Canvas Notebook');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function getConfiguredServerUrl() {
  return readDesktopConfig(app).serverUrl;
}

function isSetupSender(event) {
  const senderUrl = event.senderFrame?.url ?? '';
  return senderUrl.startsWith(SETUP_FILE_URL);
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSameConfiguredOrigin(value) {
  const serverUrl = getConfiguredServerUrl();
  if (!serverUrl) return false;

  try {
    return new URL(value).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

function isAllowedNavigation(value) {
  if (!value) return false;
  if (value.startsWith(SETUP_FILE_URL)) return true;
  if (value === 'about:blank') return true;
  return isSameConfiguredOrigin(value);
}

async function openExternalUrl(value) {
  if (!isHttpUrl(value) && !value.startsWith('mailto:')) {
    throw new Error('Only web and mail links can be opened externally.');
  }

  await shell.openExternal(value);
}

function loadSetupWindow(browserWindow, errorMessage = null) {
  loadingSetup = true;
  const query = errorMessage ? { error: errorMessage } : undefined;

  void browserWindow
    .loadFile(SETUP_FILE_PATH, query ? { query } : undefined)
    .catch(error => {
      console.error('[electron] Failed to load setup screen:', error);
    })
    .finally(() => {
      loadingSetup = false;
    });
}

function loadConfiguredServer(browserWindow) {
  const serverUrl = getConfiguredServerUrl();

  if (!serverUrl) {
    loadSetupWindow(browserWindow);
    return;
  }

  void browserWindow.loadURL(serverUrl).catch(error => {
    if (!browserWindow.isDestroyed()) {
      loadSetupWindow(browserWindow, `Could not load the configured server: ${error.message}`);
    }
  });
}

function resetServerUrlFromMenu() {
  const browserWindow = getMainWindow();
  if (!browserWindow) return;

  const response = dialog.showMessageBoxSync(browserWindow, {
    type: 'question',
    buttons: ['Reset Server URL', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Reset Server URL',
    message: 'Reset the saved Canvas Notebook server URL?',
    detail: 'The desktop app will return to the connection setup screen. Your server data is not changed.',
  });

  if (response !== 0) return;

  clearServerUrl(app);
  loadSetupWindow(browserWindow);
}

function setupNavigationGuards(browserWindow) {
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSameConfiguredOrigin(url)) {
      browserWindow.loadURL(url);
      return { action: 'deny' };
    }

    if (isHttpUrl(url) || url.startsWith('mailto:')) {
      shell.openExternal(url);
    }

    return { action: 'deny' };
  });

  browserWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (isAllowedNavigation(targetUrl)) return;

    event.preventDefault();

    if (isHttpUrl(targetUrl) || targetUrl.startsWith('mailto:')) {
      shell.openExternal(targetUrl);
    }
  });

  browserWindow.webContents.on('did-fail-load', (_event, _errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || loadingSetup || !getConfiguredServerUrl()) return;
    if (!validatedUrl || !isSameConfiguredOrigin(validatedUrl)) return;

    loadSetupWindow(browserWindow, `Could not load the configured server: ${errorDescription}`);
  });
}

function createMainWindow() {
  const config = readDesktopConfig(app);
  const windowState = config.window;
  const browserWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    ...(Number.isFinite(windowState.x) && Number.isFinite(windowState.y)
      ? { x: windowState.x, y: windowState.y }
      : {}),
    minWidth: 960,
    minHeight: 680,
    title: 'Canvas Notebook',
    icon: ICON_PATH,
    backgroundColor: '#f7f8fb',
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  mainWindow = browserWindow;
  setupNavigationGuards(browserWindow);

  if (windowState.maximized) {
    browserWindow.maximize();
  }

  browserWindow.once('ready-to-show', () => {
    browserWindow.show();
  });

  browserWindow.on('close', () => {
    saveWindowState(app, browserWindow);
  });

  browserWindow.on('closed', () => {
    if (mainWindow === browserWindow) {
      mainWindow = null;
    }
  });

  if (config.serverUrl) {
    loadConfiguredServer(browserWindow);
  } else {
    loadSetupWindow(browserWindow);
  }

  return browserWindow;
}

function registerIpcHandlers() {
  ipcMain.handle('desktop:get-app-info', () => ({
    appName: app.getName(),
    version: app.getVersion(),
    serverUrl: getConfiguredServerUrl(),
  }));

  ipcMain.handle('desktop:get-server-url', () => getConfiguredServerUrl());

  ipcMain.handle('desktop:validate-server-url', async (event, rawUrl) => {
    if (!isSetupSender(event)) {
      throw new Error('This action is only available from the connection setup screen.');
    }

    return checkServerHealth(rawUrl);
  });

  ipcMain.handle('desktop:set-server-url', async (event, rawUrl) => {
    if (!isSetupSender(event)) {
      throw new Error('This action is only available from the connection setup screen.');
    }

    const result = await checkServerHealth(rawUrl);
    if (!result.ok) return result;

    setServerUrl(app, result.serverUrl);

    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (browserWindow && !browserWindow.isDestroyed()) {
      setTimeout(() => loadConfiguredServer(browserWindow), 150);
    }

    return result;
  });

  ipcMain.handle('desktop:clear-server-url', event => {
    if (!isSetupSender(event)) {
      throw new Error('This action is only available from the connection setup screen.');
    }

    clearServerUrl(app);
    return { ok: true };
  });

  ipcMain.handle('desktop:open-external', async (event, url) => {
    if (!isSetupSender(event)) {
      throw new Error('This action is only available from the connection setup screen.');
    }

    await openExternalUrl(url);
    return { ok: true };
  });
}

registerIpcHandlers();

app.on('second-instance', () => {
  const browserWindow = getMainWindow();
  if (!browserWindow) return;

  if (browserWindow.isMinimized()) {
    browserWindow.restore();
  }

  browserWindow.focus();
});

app.whenReady().then(() => {
  createAppMenu({
    app,
    getMainWindow,
    getConfiguredServerUrl,
    loadSetupWindow,
    loadConfiguredServer,
    resetServerUrl: resetServerUrlFromMenu,
  });

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
