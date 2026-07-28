const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const hikvision = require('./hikvisionIsapi');
const { autoUpdater } = require('electron-updater');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
}

// Auto-actualización: revisa GitHub Releases, descarga en segundo plano y
// pide confirmación para reiniciar recién cuando ya está lista — el
// técnico no tiene que volver a bajar/instalar el .exe a mano cada vez.
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', async () => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Actualización disponible',
      message: 'Hay una nueva versión de FCControl lista. ¿Reiniciar ahora para aplicarla?',
      buttons: ['Reiniciar ahora', 'Más tarde'],
      defaultId: 0
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', err => {
    console.log('[autoUpdater] error:', err.message);
  });

  autoUpdater.checkForUpdates().catch(err => console.log('[autoUpdater] check failed:', err.message));
}

app.whenReady().then(() => {
  createWindow();
  if (app.isPackaged) setupAutoUpdater();
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
