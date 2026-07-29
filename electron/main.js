const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const hikvision = require('./hikvisionIsapi');
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

// Causa real confirmada con evidencia (captura + prueba con Kaspersky
// pausado, que descartó al antivirus): electron-updater's quitAndInstall()
// lanza el instalador y RECIÉN EN EL TICK SIGUIENTE llama a app.quit() —
// no hay ninguna espera real entre ambas cosas. El instalador arranca
// mientras nuestro proceso todavía está 100% vivo, así que su chequeo de
// "¿sigue corriendo FCControl?" lo detecta SIEMPRE, sin importar cuántas
// veces se reintente (no es una carrera de probabilidad, es un orden
// garantizado). Un delay antes de llamar a quitAndInstall no sirve de
// nada porque el problema está DESPUÉS de esa llamada, no antes.
//
// La única forma real de evitarlo es desacoplar el lanzamiento del
// instalador de nuestro propio proceso: un ayudante de línea de comandos
// independiente (cmd /c ping ... & start ...) espera unos segundos y
// recién ahí lanza el instalador, mientras nosotros salimos con
// app.exit() — mucho más duro e inmediato que app.quit() — apenas lo
// dejamos en marcha. Para cuando el instalador arranca, nuestro proceso
// lleva varios segundos muerto.
function beginSilentInstall() {
  if (installingUpdate) return;
  installingUpdate = true;

  const installerPath = autoUpdater.installerPath;
  if (!installerPath) {
    // No debería pasar (update-downloaded ya garantiza que el archivo
    // existe), pero si pasa, mejor esto que no instalar nunca.
    autoUpdater.quitAndInstall(true, true);
    return;
  }

  try {
    const helper = spawn(
      'cmd.exe',
      ['/c', `ping -n 6 127.0.0.1 >nul & start "" "${installerPath}" --updated /S --force-run`],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    helper.unref();
  } catch (e) {
    console.log('[autoUpdater] no se pudo lanzar el instalador desacoplado, uso el flujo normal:', e.message);
    autoUpdater.quitAndInstall(true, true);
    return;
  }

  BrowserWindow.getAllWindows().forEach(w => { try { w.destroy(); } catch (e) {} });
  app.exit(0);
}

// No se instala mientras hay una cámara a mitad de configurar (dejaría la
// cámara en un estado a medio aplicar) — en ese caso se reintenta cada
// 15s hasta que la sesión termine.
function tryInstallWhenSafe() {
  if (!updateReady || installingUpdate) return;
  if (hikvision.hasActiveSession()) {
    if (!sessionWaitTimer) {
      sessionWaitTimer = setInterval(() => {
        if (!hikvision.hasActiveSession()) {
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
  // Si estamos en medio de nuestra propia secuencia de instalación, las
  // ventanas las destruimos nosotros a propósito — no dispararle un
  // app.quit() de más acá, ya nos encargamos del quit real en
  // beginSilentInstall() después del margen de espera.
  if (installingUpdate) return;
  if (process.platform !== 'darwin') app.quit();
});

// IPC: la cámara se configura acá (proceso principal, Node puro), no en
// la ventana — así no dependemos de nada que un navegador restrinja.
ipcMain.handle('hik:readAndSecure', async (_event, opts) => hikvision.readAndSecure(opts));
ipcMain.handle('hik:applyNetwork', async (_event, opts) => hikvision.applyNetwork(opts));
