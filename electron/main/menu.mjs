import { Menu, shell } from 'electron';

function currentWebUrl(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) return null;

  const url = browserWindow.webContents.getURL();
  if (!url) return null;

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function createAppMenu(options) {
  const {
    app,
    getMainWindow,
    getConfiguredServerUrl,
    loadSetupWindow,
    loadConfiguredServer,
    resetServerUrl,
    getNotificationsEnabled,
    setNotificationsEnabled,
  } = options;

  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open in Browser',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const url = currentWebUrl(getMainWindow()) ?? getConfiguredServerUrl();
            if (url) {
              await shell.openExternal(url);
            }
          },
        },
        {
          label: 'Connection Setup',
          click: () => {
            const browserWindow = getMainWindow();
            if (browserWindow) {
              loadSetupWindow(browserWindow);
            }
          },
        },
        {
          label: 'Reset Server URL',
          click: resetServerUrl,
        },
        { type: 'separator' },
        {
          label: 'Native Notifications',
          type: 'checkbox',
          checked: getNotificationsEnabled?.() !== false,
          click: menuItem => {
            setNotificationsEnabled?.(menuItem.checked);
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            const browserWindow = getMainWindow();
            if (browserWindow) {
              browserWindow.webContents.reload();
            }
          },
        },
        {
          label: 'Reload Configured Server',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            const browserWindow = getMainWindow();
            if (browserWindow) {
              loadConfiguredServer(browserWindow);
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Back',
          accelerator: isMac ? 'Cmd+[' : 'Alt+Left',
          click: () => {
            const browserWindow = getMainWindow();
            if (browserWindow?.webContents.canGoBack()) {
              browserWindow.webContents.goBack();
            }
          },
        },
        {
          label: 'Forward',
          accelerator: isMac ? 'Cmd+]' : 'Alt+Right',
          click: () => {
            const browserWindow = getMainWindow();
            if (browserWindow?.webContents.canGoForward()) {
              browserWindow.webContents.goForward();
            }
          },
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [
              { type: 'separator' },
              { role: 'front' },
            ]
          : []),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
