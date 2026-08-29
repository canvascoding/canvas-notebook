const UPDATE_CHECK_DELAY_MS = 8_000;

function updateVersion(info) {
  return typeof info?.version === 'string' && info.version.trim() ? info.version.trim() : 'a newer version';
}

/**
 * Keeps update policy in the main process: release metadata and downloaded
 * packages are never exposed to the remote Canvas Notebook renderer.
 */
export function createDesktopUpdater({
  app,
  autoUpdater,
  dialog,
  getParentWindow,
  logger = console,
  setTimeoutFn = setTimeout,
}) {
  const enabled = app.isPackaged && process.mas !== true;
  let checkPromise = null;
  let downloadPromise = null;
  let interactiveCheck = false;
  let updateAvailable = false;

  const showMessage = async options => {
    const parentWindow = getParentWindow?.();
    return parentWindow ? dialog.showMessageBox(parentWindow, options) : dialog.showMessageBox(options);
  };

  const showError = async error => {
    logger.error('[electron-updater] Update failed:', error);
    if (!interactiveCheck && !updateAvailable) return;

    await showMessage({
      type: 'error',
      title: 'Update unavailable',
      message: 'Canvas Notebook could not check for or download an update.',
      detail: error instanceof Error ? error.message : String(error),
    });
  };

  const downloadUpdate = async () => {
    if (!enabled || downloadPromise) return downloadPromise;

    downloadPromise = Promise.resolve(autoUpdater.downloadUpdate())
      .catch(error => showError(error))
      .finally(() => {
        downloadPromise = null;
      });

    return downloadPromise;
  };

  const checkForUpdates = async ({ interactive = true } = {}) => {
    if (!enabled) return { enabled: false };
    if (checkPromise) return checkPromise;

    interactiveCheck = interactive;
    checkPromise = Promise.resolve(autoUpdater.checkForUpdates())
      .catch(error => showError(error))
      .finally(() => {
        checkPromise = null;
        interactiveCheck = false;
      });

    return checkPromise;
  };

  const configure = () => {
    if (!enabled) return false;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on('update-available', info => {
      updateAvailable = true;
      void showMessage({
        type: 'info',
        title: 'Update available',
        message: `Canvas Notebook ${updateVersion(info)} is available.`,
        detail: 'Download the signed update now? You can keep working while it downloads.',
        buttons: ['Download Update', 'Later'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) {
          void downloadUpdate();
        }
      }).catch(error => logger.error('[electron-updater] Failed to show update prompt:', error));
    });

    autoUpdater.on('update-not-available', info => {
      if (!interactiveCheck) return;

      void showMessage({
        type: 'info',
        title: 'Canvas Notebook is up to date',
        message: `You already have the latest version (${updateVersion(info)}).`,
      }).catch(error => logger.error('[electron-updater] Failed to show update status:', error));
    });

    autoUpdater.on('update-downloaded', info => {
      void showMessage({
        type: 'info',
        title: 'Update ready',
        message: `Canvas Notebook ${updateVersion(info)} has been downloaded.`,
        detail: 'Restart now to install it, or it will install automatically when you next quit the app.',
        buttons: ['Restart and Install', 'Later'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall(false, true);
        }
      }).catch(error => logger.error('[electron-updater] Failed to show restart prompt:', error));
    });

    autoUpdater.on('error', error => {
      void showError(error);
    });

    return true;
  };

  const scheduleInitialCheck = () => {
    if (!enabled) return;
    setTimeoutFn(() => {
      void checkForUpdates({ interactive: false });
    }, UPDATE_CHECK_DELAY_MS);
  };

  return { configure, checkForUpdates, scheduleInitialCheck };
}
