const { contextBridge, ipcRenderer } = require('electron');

// Misma forma que window.Capacitor.Plugins.HikvisionCamera en la app
// Android — index.html detecta cuál de las dos está presente y llama
// a la que corresponda sin cambiar el resto del código.
contextBridge.exposeInMainWorld('ElectronHikvision', {
  isElectron: true,
  readAndSecure: opts => ipcRenderer.invoke('hik:readAndSecure', opts),
  applyNetwork: opts => ipcRenderer.invoke('hik:applyNetwork', opts)
});
