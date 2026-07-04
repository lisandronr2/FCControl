# FCControl — Guía de instalación
### Base de datos: Google Sheet "CAMARAS" en tu Drive

---

## Cómo funciona

```
[Celular: FCControl PWA] ──► [Google Apps Script] ──► [Google Sheet: CAMARAS]
                                                            └─ Lee todos los datos
                                                            └─ Actualiza columna SERIAL
```

Sin servidores propios. Sin costo. 100% dentro de tu cuenta de Google.

---

## PASO 1 — Prepara tu Google Sheet "CAMARAS"

Tu archivo ya existe en Drive. Solo verifica que:

1. La pestaña (hoja) se llame **CAMARAS** (el script la detecta automáticamente; si no existe, usa la primera hoja).
2. La **fila 1** tenga los encabezados de columnas.
3. Exista al menos una columna cuyo encabezado contenga la palabra **NOMBRE**.
4. Exista al menos una columna cuyo encabezado contenga la palabra **SERIAL**.

La app lee **todas las columnas** automáticamente — no necesitas cambiar nada en el código si añades o renombras columnas. Las columnas que se muestran en la ficha son todas excepto NOMBRE (que va en el título) y SERIAL (que se captura en el formulario).

Columnas opcionales que FCControl reconoce y actualiza automáticamente al guardar:
- **FECHA** (o DATE, UPDATED) → se llena con la fecha y hora del guardado
- **TECNICO** (o TÉCNICO, VERIFIED BY) → se llena con el nombre introducido en la app

---

## PASO 2 — Publica el backend (Apps Script)

1. Abre tu Google Sheet **CAMARAS**.
2. Menú: **Extensiones → Apps Script**.
3. Borra el contenido predeterminado del editor.
4. Copia y pega el contenido del archivo **`Code.gs`** incluido en esta carpeta.
5. Guarda (Ctrl + S o ícono de disquete).
6. Haz clic en **Implementar → Nueva implementación**.
7. En "Tipo", selecciona **Aplicación web**.
8. Configura:
   - **Ejecutar como:** Yo (tu cuenta de Google)
   - **Quién tiene acceso:** Cualquier usuario
9. Clic en **Implementar**.
10. Autoriza los permisos cuando Google los solicite (es tu propio script accediendo a tu propio Sheet).
11. **Copia la URL** que aparece al final (termina en `/exec`). La usarás en el Paso 4.

> ⚠️ Cada vez que modifiques `Code.gs` debes publicar una nueva versión:
> Implementar → Gestionar implementaciones → ✏️ (editar) → Nueva versión → Actualizar.

---

## PASO 3 — Publica la app en internet (hosting gratuito)

FCControl necesita una URL pública para poder instalarse como app en el celular.

### Opción A — Netlify Drop (más rápida, sin cuenta)
1. Ve a **netlify.com/drop**
2. Arrastra la carpeta que contiene estos 4 archivos:
   - `index.html`
   - `manifest.json`
   - `sw.js`
   - `icon.svg`
3. En segundos obtienes una URL tipo `https://nombre-aleatorio.netlify.app`

### Opción B — GitHub Pages
1. Crea un repositorio público en github.com
2. Sube los 4 archivos
3. Settings → Pages → Branch: main → Save
4. Tu URL: `https://tu-usuario.github.io/nombre-repo`

> No subas la carpeta `google-apps-script/` — ese código solo va en Apps Script.

---

## PASO 4 — Instala FCControl en tu celular

1. Abre la URL de tu app (del Paso 3) en **Chrome** desde el celular.
2. Toca el menú (⋮) → **"Instalar app"** o **"Añadir a pantalla de inicio"**.
3. Abre FCControl desde el ícono que aparece en tu pantalla.
4. La primera vez mostrará la pantalla de configuración → pega la URL de Apps Script del Paso 2 → **Conectar**.

---

## Uso diario

### Buscar y capturar el serial de una cámara

1. Escribe el nombre (o parte del nombre) en el campo de búsqueda.
   → El desplegable muestra coincidencias en tiempo real con resaltado.
   → Los dispositivos ya capturados hoy aparecen marcados con **✓ Listo**.
   → Navega con las flechas ↑↓ del teclado y selecciona con Enter.

2. Selecciona el dispositivo → se abre la ficha con **todos los datos de tu Sheet** (IP, Máscara, Gateway, VLAN, Modelo, Puertos, etc.).

3. Escribe el **Serial Number** capturado físicamente en campo.

4. Opcional: escribe el nombre del **técnico** que verifica.

5. Toca **"Guardar serial en el Sheet"**.
   → La app actualiza directamente la columna SERIAL de tu Google Sheet.
   → Si tienes columna FECHA o TECNICO, las actualiza también.
   → El dispositivo queda marcado como ✓ en el desplegable de búsqueda.

### Resumen del día
- Pestaña **📋 Resumen** → progreso visual del día (capturados vs pendientes).
- Lista cronológica de todos los seriales capturados en la sesión.
- El log se reinicia automáticamente cada nuevo día.

---

## Estructura de archivos

```
fccontrol/
├── index.html                  ← La app completa
├── manifest.json               ← La hace instalable como PWA
├── sw.js                       ← Carga rápida (service worker)
├── icon.svg                    ← Ícono en pantalla de inicio
├── README.md                   ← Esta guía
└── google-apps-script/
    └── Code.gs                 ← Backend: lee y escribe en tu Sheet CAMARAS
```

---

## Lo que Code.gs hace en tu Sheet

| Acción | Qué toca |
|--------|----------|
| Al abrir la app | Lee la columna NOMBRE para el autocompletado |
| Al seleccionar un dispositivo | Lee **toda la fila** de ese dispositivo |
| Al guardar | Escribe solo en columna SERIAL (+ FECHA y TECNICO si existen) |

Ninguna otra columna es modificada.

