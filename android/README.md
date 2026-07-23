# FCControl Mobile (Android) — Configuración automática de cámaras Hikvision

Wrapper nativo de la PWA de FCControl hecho con [Capacitor](https://capacitorjs.com/),
que agrega un plugin nativo (`HikvisionCameraPlugin`) capaz de hablar la ISAPI
de una cámara Hikvision conectada a la WiFi/red local del teléfono — algo que
el navegador no puede hacer por contenido mixto (HTTPS→HTTP) y falta de CORS.

El resto de la app (index.html, búsqueda, Sheet, cola offline, escáner QR)
es exactamente el mismo código que corre en la PWA web — no se duplica ni
se bifurca. `index.html` detecta en runtime si corre dentro de esta app
nativa (`window.Capacitor?.isNativePlatform()`) y solo entonces muestra el
botón "⚡ Configurar automáticamente" dentro del modal de "Configurar cámara".

## Compilar

```bash
npm install
npm run android:build   # sync:www + cap sync + gradlew assembleDebug
```

El APK queda en `android/app/build/outputs/apk/debug/app-debug.apk`.

Para instalar directo en un teléfono conectado por USB (con depuración USB activada):
```bash
cd android
gradlew.bat installDebug
```

`www/` es un artefacto de build (generado por `scripts/sync-www.js` a partir
de los archivos en la raíz del repo) — no se edita a mano ni se versiona.

## Qué hace el plugin nativo (`HikvisionCameraPlugin`)

Dos métodos expuestos a JS vía `Capacitor.Plugins.HikvisionCamera`:

### `readAndSecure({ accessIp, currentUser?, currentPass?, newPass })`
1. Intenta `POST /ISAPI/Security/activate` (sin auth) — si la cámara está
   de fábrica sin activar, esto la activa con usuario `admin` y la
   contraseña indicada.
2. Si ya estaba activa (la activación falla con "alreadyActivated"), hace
   login Digest con `currentUser`/`currentPass` (por defecto `admin`/`12345`)
   y cambia la contraseña vía `PUT /ISAPI/Security/users/1`.
3. Con las credenciales ya válidas, lee `GET /ISAPI/System/Network/interfaces`
   — de ahí saca la **MAC real** (`<Link><MACAddress>`), la IP/máscara
   actuales y el `id` de la interfaz de red.
4. Guarda la sesión (cliente + credenciales + interfaceId) en memoria,
   keyed por `accessIp`, para el siguiente paso.

### `applyNetwork({ accessIp, targetIp, targetMask, targetGateway })`
`PUT /ISAPI/System/Network/interfaces/{id}` con la IP/máscara/gateway
objetivo (los que trae el Sheet). Usa la sesión guardada por `readAndSecure`.

**Importante:** al cambiar la IP, la cámara corta la conexión a mitad de la
respuesta HTTP (cambia de dirección mientras responde). Un `SocketTimeoutException`
en esta llamada específica se trata como **éxito probable**, no como error —
es el comportamiento esperado, no un bug.

## Por qué las llamadas van "atadas" a la WiFi

Cada request usa `Network.openConnection(url)` sobre la red WiFi activa
detectada vía `ConnectivityManager`, en vez de dejar que el sistema elija
la ruta por defecto. Esto evita que:
- El teléfono intente salir por datos móviles hacia una IP privada (falla).
- Android desconecte la WiFi de la cámara por "sin acceso a internet" y
  el tráfico se vaya por otro lado sin que la app se entere.

Solo esta llamada puntual usa esa red — el resto de la app (Sheet, PDF,
etc.) sigue usando la ruta normal del teléfono.

## `usesCleartextTraffic="true"`

Necesario porque la ISAPI de Hikvision es HTTP plano y la IP de la cámara
es arbitraria (varía por obra/dispositivo, no se puede acotar a un dominio
fijo en `network_security_config.xml`). Esto **no** reabre el problema de
contenido mixto de la PWA: `allowMixedContent` de la WebView sigue en
`false` — el HTTP plano solo lo usa el cliente nativo del plugin, nunca
la WebView que muestra la UI.

## Limitaciones conocidas (a validar en campo)

- **Solo Digest Auth.** Firmware muy viejo que use Basic Auth no está soportado.
- **Parseo de XML por nombre de tag, ignorando namespace/orden.** Se asume
  el esquema típico de Hikvision (`ipAddress` de la propia interfaz aparece
  antes que el de `DefaultGateway`/`PrimaryDNS` en el documento). Firmwares
  o modelos con un orden distinto podrían leer mal el valor — por eso el
  estado en pantalla muestra la MAC/IP leídas antes de aplicar el cambio,
  para que el técnico las verifique visualmente.
- **Username fijo `admin`.** No se intenta renombrar el usuario administrador
  por convención de Hikvision (el `id=1` es el admin de fábrica).
- **No probado aún contra hardware real** — falta validar en campo con
  cámaras Hikvision reales antes de confiar en el flujo automático; el
  modo asistido (copiar/pegar manual) sigue disponible como respaldo si
  el automático falla.
