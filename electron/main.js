import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron/main';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const appUrl = 'http://127.0.0.1:8080';

let mainWindow;
let backendServer;

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
      prepareRuntimePaths();
      ({ server: backendServer } = await import('../server.js'));
      await waitForBackend();
      await createWindow();
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
