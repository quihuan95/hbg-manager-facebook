const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
ipcMain.handle('window:is-maximized', () => false);
ipcMain.on('window:minimize', () => {});
ipcMain.on('window:toggle-maximize', () => {});
ipcMain.on('window:close', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, frame: false, width: 1920, height: 1030,
    webPreferences: { preload: path.join(__dirname, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  await win.loadURL('http://127.0.0.1:8090/#publishing');
  await new Promise(resolve => setTimeout(resolve, 1800));
  const result = await win.webContents.executeJavaScript(`(() => {
    const main = document.querySelector('main');
    const view = document.querySelector('#viewScroll');
    const table = [...document.querySelectorAll('.tablewrap')].find(element => element.getBoundingClientRect().width > 0);
    const tableScroller = table?.querySelector('.simplebar-content-wrapper');
    const rect = element => element ? ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width }) : null;
    return {
      viewportWidth: innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      main: rect(main),
      view: rect(view),
      panel: rect([...document.querySelectorAll('.panel')].find(element => element.getBoundingClientRect().width > 0)),
      stats: rect(document.querySelector('.stats')),
      tableHost: rect(table),
      tableClientWidth: table?.clientWidth,
      tableInnerClientWidth: tableScroller?.clientWidth,
      tableInnerScrollWidth: tableScroller?.scrollWidth
    };
  })()`);
  process.stdout.write(JSON.stringify(result, null, 2));
  app.quit();
});
