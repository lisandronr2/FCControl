const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const hikvision = require('./hikvisionIsapi');
const omadaSwitch = require('./omadaSwitch');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let updateReady = false;      // instalador ya descargado, esperando el momento seguro de aplicarlo
let installingUpdate = false; // ya arrancamos la secuencia de instalación (no reentrar)
let updateRetried = false;    // un solo reintento automático por sesión ante error de descarga/instalación
let sessionWaitTimer = null;

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

// Historia de este método (para no volver a probar lo mismo si esto se
// rompe de nuevo): primero se intentó un delay antes de quitAndInstall —
// no servía, porque electron-updater lanza el instalador y llama a
// app.quit() casi en el mismo tick, sin espera real entre ambas cosas.
// Después se intentó desacoplar el lanzamiento con un helper propio
// (wscript + cmd + start) para sobrevivir al cierre de la app — tampoco
// funcionó: confirmado en la práctica que el proceso "hijo" no sobrevivía
// al app.exit() (probablemente por cómo Windows mata en cascada los
// procesos de un mismo Job Object, algo que Electron no permite evitar
// desde JS). La solución real terminó siendo otra: arreglar el problema
// del lado del instalador (ver build/installer.nsh, customCheckAppRunning)
// para que tolere que el proceso viejo tarde unos segundos en cerrarse —
// con eso ya no hace falta ningún truco acá, alcanza con el mecanismo
// estándar de la librería.
function beginSilentInstall() {
  if (installingUpdate) return;
  installingUpdate = true;
  autoUpdater.quitAndInstall(/* isSilent */ true, /* isForceRunAfter */ true);
}

// No se instala mientras hay una cámara a mitad de configurar (dejaría la
// cámara en un estado a medio aplicar) — en ese caso se reintenta cada
// 15s hasta que la sesión termine.
function tryInstallWhenSafe() {
  if (!updateReady || installingUpdate) return;
  if (hikvision.hasActiveSession() || omadaSwitch.hasActiveSession()) {
    if (!sessionWaitTimer) {
      sessionWaitTimer = setInterval(() => {
        if (!hikvision.hasActiveSession() && !omadaSwitch.hasActiveSession()) {
          clearInterval(sessionWaitTimer);
          sessionWaitTimer = null;
          beginSilentInstall();
        }
      }, 15000);
    }
    return;
  }
  beginSilentInstall();
}

// Auto-actualización: revisa GitHub Releases, descarga en segundo plano y
// se instala sola apenas está lista — sin pedirle nada al técnico. Antes
// mostraba un diálogo de confirmación; en la práctica eso se veía como si
// la app se hubiera "colgado" (quedaba esperando un click detrás de otra
// ventana), así que ahora es 100% desatendido.
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // lo controlamos a mano (ver tryInstallWhenSafe/beginSilentInstall)
  autoUpdater.disableDifferentialDownload = true; // evita descargas parciales corruptas, causa típica de instaladores colgados

  autoUpdater.on('update-downloaded', () => {
    updateReady = true;
    tryInstallWhenSafe();
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

app.on('window-all-closed', () => {
  // Si esto se disparó porque quitAndInstall() ya está cerrando todo, no
  // hace falta (ni conviene) llamar a app.quit() de nuevo acá.
  if (installingUpdate) return;
  if (process.platform !== 'darwin') app.quit();
});

// IPC: la cámara se configura acá (proceso principal, Node puro), no en
// la ventana — así no dependemos de nada que un navegador restrinja.
ipcMain.handle('hik:readAndSecure', async (_event, opts) => hikvision.readAndSecure(opts));
ipcMain.handle('hik:applyNetwork', async (_event, opts) => hikvision.applyNetwork(opts));

// IPC: mismo patrón para switches TP-Link Omada (dispositivos ARMxx).
ipcMain.handle('switch:readAndSecure', async (_event, opts) => omadaSwitch.readAndSecure(opts));
ipcMain.handle('switch:applyNetwork', async (_event, opts) => omadaSwitch.applyNetwork(opts));
