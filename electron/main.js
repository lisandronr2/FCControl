const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const hikvision = require('./hikvisionIsapi');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let updateReady = false;   // instalador ya descargado, esperando el momento seguro de aplicarlo
let updateRetried = false; // un solo reintento automático por sesión ante error de descarga/instalación

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

// Limpia el caché del instalador de actualizaciones (donde electron-updater
// guarda el .exe descargado antes de ejecutarlo). Un instalador a medio
// descargar o corrompido ahí es la causa más común de que el asistente de
// NSIS se quede "colgado" en la próxima actualización — se lo borra para
// que el siguiente intento arranque de cero en vez de repetir el mismo
// fallo para siempre.
function cleanUpdaterCache() {
  const candidates = [
    path.join(app.getPath('appData'), 'fccontrol-mobile-updater'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'fccontrol-mobile-updater') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'fccontrol-mobile-updater') : null
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.log('[autoUpdater] no se pudo limpiar caché de actualización en', dir, e.message);
    }
  }
}

// Instala en segundo plano, sin ningún cuadro de diálogo: el NSIS corre
// con /S (silencioso) y la app se reabre sola al terminar. No se fuerza
// mientras hay una cámara a mitad de configurar, para no dejarla en un
// estado a medio aplicar — en ese caso queda pendiente y se instala sola
// al cerrar la app (ver 'before-quit').
function installSilentlyIfSafe() {
  if (!updateReady) return;
  if (hikvision.hasActiveSession()) return;
  autoUpdater.quitAndInstall(/* isSilent */ true, /* isForceRunAfter */ true);
}

// Auto-actualización: revisa GitHub Releases, descarga en segundo plano y
// se instala sola apenas está lista — sin pedirle nada al técnico. Antes
// mostraba un diálogo de confirmación; en la práctica eso se veía como si
// la app se hubiera "colgado" (quedaba esperando un click detrás de otra
// ventana), así que ahora es 100% desatendido.
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // lo controlamos a mano (ver before-quit)
  autoUpdater.disableDifferentialDownload = true; // evita descargas parciales corruptas, causa típica de instaladores colgados

  autoUpdater.on('update-downloaded', () => {
    updateReady = true;
    installSilentlyIfSafe();
  });

  autoUpdater.on('error', err => {
    console.log('[autoUpdater] error:', err.message);
    if (!updateRetried) {
      updateRetried = true;
      cleanUpdaterCache();
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch(e => console.log('[autoUpdater] reintento falló:', e.message));
      }, 30000);
    }
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

app.on('before-quit', () => {
  // Si la actualización quedó pendiente porque había una cámara en
  // configuración, al cerrar la app ya es seguro aplicarla.
  if (updateReady) installSilentlyIfSafe();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: la cámara se configura acá (proceso principal, Node puro), no en
// la ventana — así no dependemos de nada que un navegador restrinja.
ipcMain.handle('hik:readAndSecure', async (_event, opts) => hikvision.readAndSecure(opts));
ipcMain.handle('hik:applyNetwork', async (_event, opts) => hikvision.applyNetwork(opts));
