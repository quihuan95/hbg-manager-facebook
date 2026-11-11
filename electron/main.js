import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron/main';
import updaterPackage from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const appUrl = 'http://127.0.0.1:8080';
const { autoUpdater } = updaterPackage;

let mainWindow;
let backendServer;
let updateCheckPromise = null;
let updateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  availableVersion: null,
  percent: 0,
  message: 'Sẵn sàng kiểm tra cập nhật.'
};

function canAutoUpdate() {
  return app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
}

function publishUpdateState(patch) {
  updateState = { ...updateState, ...patch, currentVersion: app.getVersion() };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:state', updateState);
  }
}

function configureAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => publishUpdateState({
    status: 'checking',
    percent: 0,
    message: 'Đang kiểm tra phiên bản mới...'
  }));
  autoUpdater.on('update-available', info => publishUpdateState({
    status: 'available',
    availableVersion: info.version,
    percent: 0,
    message: `Đã tìm thấy phiên bản ${info.version}. Đang tải xuống...`
  }));
  autoUpdater.on('update-not-available', info => publishUpdateState({
    status: 'not-available',
    availableVersion: info?.version || null,
    percent: 0,
    message: 'Bạn đang dùng phiên bản mới nhất.'
  }));
  autoUpdater.on('download-progress', progress => publishUpdateState({
    status: 'downloading',
    percent: Math.max(0, Math.min(100, Math.round(progress.percent || 0))),
    message: `Đang tải bản cập nhật ${Math.round(progress.percent || 0)}%...`
  }));
  autoUpdater.on('update-downloaded', info => publishUpdateState({
    status: 'downloaded',
    availableVersion: info.version,
    percent: 100,
    message: `Phiên bản ${info.version} đã sẵn sàng để cài đặt.`
  }));
  autoUpdater.on('error', error => publishUpdateState({
    status: 'error',
    percent: 0,
    message: `Không thể cập nhật: ${error?.message || String(error)}`
  }));
}

async function checkForUpdates() {
  if (!canAutoUpdate()) {
    publishUpdateState({
      status: 'unsupported',
      message: app.isPackaged
        ? 'Bản portable không hỗ trợ tự động cập nhật. Hãy dùng bản cài đặt NSIS.'
        : 'Tự động cập nhật chỉ hoạt động trong bản ứng dụng đã đóng gói.'
    });
    return updateState;
  }
  if (updateCheckPromise) return updateCheckPromise;
  updateCheckPromise = autoUpdater.checkForUpdates()
    .catch(error => {
      publishUpdateState({ status: 'error', message: `Không thể kiểm tra cập nhật: ${error?.message || String(error)}` });
      return null;
    })
    .finally(() => { updateCheckPromise = null; });
  await updateCheckPromise;
  return updateState;
}

process.on('hbg-app-restart', () => {
  app.relaunch();
  app.exit(0);
});

function prepareRuntimePaths() {
  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'data');
  const userEnv = path.join(userData, '.env');
  const portableEnv = path.join(path.dirname(app.getPath('exe')), '.env');
  const projectEnv = path.join(projectRoot, '.env');
  const exampleEnv = path.join(projectRoot, '.env.example');

  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(userEnv) && fs.existsSync(exampleEnv)) {
    fs.copyFileSync(exampleEnv, userEnv);
  }

  process.env.HBG_DATA_DIR = dataDir;
  process.env.HBG_ENV_PATH = fs.existsSync(portableEnv)
    ? portableEnv
    : (!app.isPackaged && fs.existsSync(projectEnv) ? projectEnv : userEnv);
  process.env.API_PORT = '8080';
  process.env.FRONTEND_ORIGIN = appUrl;
  process.env.GOOGLE_REDIRECT_URI = `${appUrl}/api/oauth/google/callback`;
}

async function waitForBackend(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${appUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Backend is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Backend không khởi động trong thời gian cho phép.');
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 820,
    minHeight: 620,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#f4f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const sendMaximizedState = () => {
    if (!mainWindow?.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaximizedState);
  mainWindow.on('unmaximize', sendMaximizedState);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(appUrl);
  mainWindow.show();
}

ipcMain.on('window:minimize', event => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.on('window:toggle-maximize', event => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  window.isMaximized() ? window.unmaximize() : window.maximize();
});
ipcMain.on('window:close', event => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
ipcMain.handle('window:is-maximized', event => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() || false;
});
ipcMain.handle('updater:get-state', () => updateState);
ipcMain.handle('updater:check', () => checkForUpdates());
ipcMain.handle('updater:install', () => {
  if (updateState.status !== 'downloaded') return false;
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
});

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      configureAutoUpdater();
      prepareRuntimePaths();
      ({ server: backendServer } = await import('../server.js'));
      await waitForBackend();
      await createWindow();
      setTimeout(() => checkForUpdates(), 5000).unref();
    } catch (error) {
      dialog.showErrorBox('Không thể mở HBG Content Studio', error?.stack || error?.message || String(error));
      app.quit();
    }
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (backendServer?.listening) backendServer.close();
});
