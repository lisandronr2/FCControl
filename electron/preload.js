const { contextBridge, ipcRenderer } = require('electron');

// Misma forma que window.Capacitor.Plugins.HikvisionCamera en la app
// Android — index.html detecta cuál de las dos está presente y llama
// a la que corresponda sin cambiar el resto del código.
contextBridge.exposeInMainWorld('ElectronHikvision', {
  isElectron: true,
  readAndSecure: opts => ipcRenderer.invoke('hik:readAndSecure', opts),
  applyNetwork: opts => ipcRenderer.invoke('hik:applyNetwork', opts)
});

// Mismo patrón para switches TP-Link Omada (dispositivos ARMxx) — un
// módulo de automatización propio, ver electron/omadaSwitch.js.
contextBridge.exposeInMainWorld('ElectronOmadaSwitch', {
  isElectron: true,
  readAndSecure: opts => ipcRenderer.invoke('switch:readAndSecure', opts),
  applyNetwork: opts => ipcRenderer.invoke('switch:applyNetwork', opts)
});

// Exportar a PDF sin pasar por window.print(): en varias máquinas de
// campo no hay ninguna impresora (ni siquiera la virtual "Microsoft
// Print to PDF") instalada/habilitada, y en ese caso el diálogo nativo
// de impresión de Chromium simplemente no aparece — el botón "PDF"
// parecía no hacer nada. Este camino genera el PDF en el proceso
// principal (webContents.printToPDF, no depende de ningún driver de
// impresora) y lo guarda directo en disco.
contextBridge.exposeInMainWorld('ElectronPDF', {
  isElectron: true,
  exportPDF: suggestedName => ipcRenderer.invoke('pdf:export', { suggestedName })
});
