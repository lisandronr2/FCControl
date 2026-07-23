# FCControl Desktop (Windows) — Electron

Wrapper de escritorio de la misma app web (`index.html` en la raíz del
repo, sin duplicar código) que agrega configuración automática de
cámaras Hikvision — el equivalente de escritorio del plugin nativo
Android (`android/app/.../HikvisionCameraPlugin.kt`).

## Por qué funciona distinto que en Android/PWA

En el navegador (y en el WebView de Capacitor) hablar HTTP plano con
la ISAPI de la cámara está bloqueado por contenido mixto y CORS. En
Electron, la ventana (`index.html`) sigue siendo una página web con
esas mismas restricciones — pero el **proceso principal** de Electron
es Node puro, sin sandbox de navegador. La solución: la ventana le
pide al proceso principal por IPC que hable con la cámara, y el
proceso principal (que no tiene ninguna de esas restricciones) hace
la llamada real.

```
index.html (ventana, restringida)
   │  window.ElectronHikvision.readAndSecure(...)   [expuesto por preload.js]
   ▼
ipcRenderer.invoke('hik:readAndSecure', ...)
   │
   ▼
main.js → hikvisionIsapi.js (proceso principal, Node puro, sin restricciones)
   │
   ▼
Cámara Hikvision por HTTP plano en la red local
```

`index.html` detecta automáticamente cuál puente está disponible
(`window.Capacitor.Plugins.HikvisionCamera` en Android, o
`window.ElectronHikvision` acá) vía `getHikPlugin()` — el resto del
código de la UI es idéntico en ambas plataformas.

## Correr en desarrollo

```bash
npm install
npm run electron:dev
```

## Compilar el instalador de Windows

```bash
npm run electron:build
```

Genera un instalador NSIS en `electron-dist/`.

## Limitaciones (compartidas con la versión Android)

Ver [`android/README.md`](../android/README.md) — mismas asunciones
sobre el esquema XML de la ISAPI, mismo manejo del corte de conexión
esperado al cambiar la IP de la cámara, mismo alcance de Digest Auth
únicamente. **No probado todavía contra hardware real.**

## Impresión / exportar PDF-Excel

A diferencia del WebView embebido de Capacitor, Electron sí implementa
`window.print()` y la descarga de archivos vía `<a download>` de forma
nativa (es Chromium completo) — no hizo falta ningún puente adicional
para eso, `index.html` usa el mismo camino que en un navegador normal.
