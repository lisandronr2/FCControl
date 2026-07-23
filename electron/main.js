const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const hikvision = require('./hikvisionIsapi');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: la cámara se configura acá (proceso principal, Node puro), no en
// la ventana — así no dependemos de nada que un navegador restrinja.
ipcMain.handle('hik:readAndSecure', async (_event, opts) => hikvision.readAndSecure(opts));
ipcMain.handle('hik:applyNetwork', async (_event, opts) => hikvision.applyNetwork(opts));
