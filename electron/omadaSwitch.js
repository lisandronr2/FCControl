// Configuración de switches TP-Link Omada (standalone, sin controlador) —
// corre en el proceso principal de Electron, mismo patrón que
// hikvisionIsapi.js: abre una BrowserWindow apuntada al panel web real del
// switch y lo automatiza como lo haría un técnico (login, cambio de
// contraseña forzado, System Summary, IP Settings).
//
// Dispositivos de nombre ARMxx en el Sheet son switches (IES210GPP u
// similar) en vez de cámaras — index.html decide qué módulo llamar según
// el nombre del dispositivo.

const { BrowserWindow, app } = require('electron');
const fs = require('fs');
const path = require('path');

function setNativeValue(js) {
  // Mismo motivo que en hikvisionIsapi.js: los inputs de un SPA moderno
  // (React/Vue) no detectan cambios hechos con .value = x directo — hay
  // que usar el setter nativo del prototipo y disparar 'input'/'change'.
  return `
    (function(el, val){
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })(${js})
  `;
}

async function exec(win, script) {
  return win.webContents.executeJavaScript(script);
}

// Historia de este helper (para no repetir el mismo error): la primera
// versión buscaba en "todos los frames de la ventana" usando la API de
// Electron win.webContents.mainFrame.framesInSubtree, ejecutando JS por
// separado en cada WebFrameMain. Confirmado con captura de diagnóstico
// real que esa API solo devolvía 2 frames en este switch (el documento
// contenedor + un iframe vacío) y NUNCA llegaba al <iframe name="mainFrame">
// real donde vive todo el contenido (System Summary, IP Settings, el
// diálogo "Confirm submission?") — aun cuando ese iframe se ve
// perfectamente en los screenshots. Los <iframe src=""> de este panel
// clásico se llenan por JS (probablemente document.write dentro del
// propio contentDocument), y framesInSubtree no los reflejaba bien.
//
// Reemplazado por acceso directo a contentDocument: todo corre en UNA
// sola llamada a win.webContents.executeJavaScript (siempre el frame de
// nivel superior), que recorre document + todos los <iframe>/<frame>
// mismo-origen vía su .contentDocument — esto es JS estándar del DOM, no
// depende de ninguna API de Electron, y punto clave: como la referencia
// al elemento encontrado sigue siendo un nodo del DOM real (aunque viva
// en un iframe anidado), se le puede llamar .click() directo y el evento
// se dispara correctamente DENTRO de su propio documento — sin necesidad
// de traducir coordenadas ni de decidir si el click debe ser "real" por
// mouse o no.
const COLLECT_DOCS_JS = `
  (function collectDocs(){
    const docs = [document];
    const seen = new Set([document]);
    const stack = [document];
    while (stack.length) {
      const doc = stack.pop();
      let frames = [];
      try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (e) {}
      for (const f of frames) {
        let d = null;
        try { d = f.contentDocument; } catch (e) { /* cross-origin, sin acceso */ }
        if (d && !seen.has(d)) { seen.add(d); docs.push(d); stack.push(d); }
      }
    }
    return docs;
  })()
`;

function allElementsJs() {
  return `(${COLLECT_DOCS_JS}).flatMap(d => { try { return Array.from(d.querySelectorAll('*')); } catch(e) { return []; } })`;
}

// Selector de "cualquier cosa clickeable" usado en todo el módulo.
// Confirmado con captura de diagnóstico real: el botón OK del diálogo
// "Confirm submission?" NO es <button>/<a>/<input> — es
// <div class="alert_btn close" id="alert_ok">OK</div>, un <div> normal
// con su propio manejador de click. Ya habíamos aprendido esta lección
// con "Login" (era <input type=submit>) y el menú lateral (eran <a>) —
// este panel simplemente no usa elementos semánticos de botón en ningún
// lado. [class*="btn"] cubre este patrón (clases como "alert_btn"), y
// [onclick] es un respaldo genérico para cualquier otro caso similar.
const CLICKABLE_SELECTOR = 'button, [role=button], a, input[type=submit], input[type=button], [class*="btn"], [onclick]';

function containsTextAnyDocJs(text) {
  return `(${COLLECT_DOCS_JS}).some(d => d.body && d.body.textContent.includes(${JSON.stringify(text)}))`;
}

async function waitFor(win, conditionJs, timeoutMs = 10000, intervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await exec(win, conditionJs).catch(() => false);
    if (ok) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

function findLabelValueCellJs(labelText) {
  // Los formularios de Omada son filas "label a la izquierda, valor a la
  // derecha" sin agrupación semántica clara (no hay <label for=...>) — se
  // busca el texto de la etiqueta y se toma la celda HERMANA siguiente
  // como valor.
  // Confirmado con captura de diagnóstico real: la etiqueta en el DOM es
  // "Device Name" SIN los dos puntos — el ":" se agrega visualmente por
  // CSS (patrón típico de esta UI clásica basada en tablas), no es texto
  // real. Se normalizan los dos puntos finales de AMBOS lados antes de
  // comparar.
  // Bug real confirmado en producción: la versión anterior buscaba un
  // <input>/<select> con querySelector subiendo varios ancestros — en
  // filas de SOLO LECTURA (MAC Address, Serial Number, etc., que no
  // tienen ningún <input>, solo texto) terminaba agarrando el <input> de
  // OTRA fila (Device Name) por estar en el mismo contenedor. Ahora se
  // sube únicamente hasta encontrar la celda con un hermano siguiente, y
  // se usa ESE hermano — nunca la subrama completa de un ancestro lejano.
  const norm = s => (s || '').trim().replace(/:\s*$/, '');
  return `
    (function(){
      const target = ${JSON.stringify(norm(labelText))};
      const all = ${allElementsJs()};
      const lbl = all.find(el => el.children.length === 0 && (el.textContent || '').trim().replace(/:\\s*$/, '') === target);
      if (!lbl) return null;
      let cell = lbl;
      let hops = 0;
      while (cell && !cell.nextElementSibling && cell.parentElement && hops < 5) {
        cell = cell.parentElement;
        hops++;
      }
      return cell ? cell.nextElementSibling : null;
    })()
  `;
}

async function setFieldByLabel(win, labelText, value) {
  return exec(win, `
    (function(){
      const cell = ${findLabelValueCellJs(labelText)};
      if (!cell) return false;
      const field = (cell.matches && cell.matches('input, select')) ? cell : cell.querySelector('input, select');
      if (!field) return false;
      if (field.tagName === 'SELECT') {
        const opt = Array.from(field.options).find(o => o.textContent.trim() === ${JSON.stringify(value)} || o.value === ${JSON.stringify(value)});
        if (!opt) return false;
        field.value = opt.value;
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      ${setNativeValue(`field, ${JSON.stringify(value)}`)};
      return true;
    })()
  `).catch(() => false);
}

async function getFieldByLabel(win, labelText) {
  return exec(win, `
    (function(){
      const cell = ${findLabelValueCellJs(labelText)};
      if (!cell) return null;
      const field = (cell.matches && cell.matches('input, select')) ? cell : cell.querySelector('input, select');
      if (field) return (field.value || '').trim();
      return (cell.textContent || '').trim();
    })()
  `).catch(() => null);
}

// Causa raíz real del login trabado, confirmada con captura de
// diagnóstico: el botón "Login" de esta pantalla NO es un <button> —
// es <input type="submit" value="Login" onclick="return doOnclick();">
// (una página clásica de formulario, ni siquiera React). Buscar solo
// 'button' nunca lo iba a encontrar, sin importar si el click era
// sintético o real — el problema nunca fue "isTrusted", fue el
// selector. Ahora matchea tanto <button>/[role=button] (por
// textContent) como <input type=submit|button> (por su atributo value,
// ya que estos elementos no tienen textContent), buscando en TODOS los
// documentos accesibles (ver COLLECT_DOCS_JS) — el menú lateral
// ("IP Settings", "System Summary", etc.) son <a> sin href en el
// documento de nivel superior, pero botones como "Apply"/"Login" viven
// dentro del <iframe name="mainFrame">.
function findButtonByTextJs(text) {
  return `
    (function(){
      const t = ${JSON.stringify(text)};
      const all = ${allElementsJs()};
      const byText = all.filter(b => b.matches && b.matches(${JSON.stringify(CLICKABLE_SELECTOR)}))
        .find(b => (b.textContent || '').trim() === t || (b.textContent || '').trim().includes(t));
      if (byText) return byText;
      return all.filter(b => b.matches && b.matches('input[type=submit], input[type=button]'))
        .find(i => (i.value || '').trim() === t || (i.value || '').trim().includes(t));
    })()
  `;
}

// Encuentra el elemento (posiblemente dentro de un iframe mismo-origen
// anidado) y lo clickea en el mismo documento donde vive — sin
// coordenadas, sin sendInputEvent. El bug del botón Login nunca fue por
// clicks no confiables (isTrusted) — fue un selector mal armado — así
// que un click de DOM normal alcanza para todo este módulo.
async function realClick(win, findElJs, timeoutMs = 6000) {
  const clickJs = `
    (function(){
      const el = ${findElJs};
      if (!el) return false;
      if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return true;
    })()
  `;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const clicked = await exec(win, clickJs).catch(() => false);
    if (clicked) {
      await new Promise(r => setTimeout(r, 400));
      return true;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function clickButton(win, text, timeoutMs = 2000) {
  return realClick(win, findButtonByTextJs(text), timeoutMs);
}

// Guarda screenshot + el HTML de CADA documento accesible (nivel
// superior y todos los iframes mismo-origen, ver COLLECT_DOCS_JS) en el
// momento exacto del fallo, para diagnosticar con datos reales en vez de
// seguir adivinando selectores a ciegas.
async function dumpDiagnostics(win, label) {
  try {
    const dir = path.join(app.getPath('userData'), 'debug');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    const png = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `switch-${label}-${stamp}.png`), png.toPNG());

    const htmls = await exec(win, `(${COLLECT_DOCS_JS}).map(d => { try { return d.documentElement.outerHTML; } catch(e) { return '(sin acceso)'; } })`).catch(() => []);
    (htmls || []).forEach((html, i) => {
      fs.writeFileSync(path.join(dir, `switch-${label}-${stamp}-doc${i}.html`), html || '');
    });

    return dir;
  } catch (e) {
    return null;
  }
}

// Diálogos de confirmación tipo "Confirm submission?" (OK/Cancel).
// Confirmado con captura real: al igual que "Login" y los enlaces del
// menú, los botones de este diálogo no son necesariamente <button> — hay
// que buscarlos igual que en findButtonByTextJs (button/[role=button]/a/
// input[type=submit|button]), y subir más de un nivel de ancestro porque
// el contenedor del modal puede estar varios niveles arriba del texto.
//
// Bug real confirmado en producción: esta búsqueda no exigía que el
// texto "confirm" encontrado estuviera VISIBLE — clasificadores como
// este panel suelen tener plantillas ocultas (display:none) o copias
// del modal en el DOM que se clonan/muestran recién al abrirlo. Sin el
// filtro de visibilidad, el código podía matchear una de esas copias
// ocultas y clickear un botón "OK" decorativo sin ningún efecto real:
// la app reportaba éxito pero el switch no cambiaba nada. Ahora se exige
// que tanto el texto como el botón candidato estén realmente visibles.
function isVisibleJs(varName) {
  return `(function(el){ if(!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.offsetParent !== null; })(${varName})`;
}

function findDialogButtonByTextHintJs(textHint) {
  return `
    (function(){
      const isVisible = ${isVisibleJs('el')};
      const all = ${allElementsJs()};
      const textEl = all.find(el => el.children.length === 0 && new RegExp(${JSON.stringify(textHint)}, 'i').test((el.textContent || '').trim()) && (el.textContent || '').trim().length < 80 && isVisible(el));
      if (!textEl) return null;
      let container = textEl.parentElement;
      let hops = 0;
      while (container && hops < 8) {
        const candidates = Array.from(container.querySelectorAll(${JSON.stringify(CLICKABLE_SELECTOR)}))
          .filter(b => (b.textContent || b.value || '').trim().length > 0 && isVisible(b));
        if (candidates.length) {
          const ok = candidates.find(b => /^ok$/i.test((b.textContent || b.value || '').trim()))
            || candidates.find(b => !/cancel/i.test((b.textContent || b.value || '').trim()));
          if (ok) return ok;
        }
        container = container.parentElement;
        hops++;
      }
      return null;
    })()
  `;
}

// Comprueba si sigue habiendo, en cualquier documento accesible, un
// texto visible que matchee el hint del diálogo — usado para verificar
// que un click realmente lo cerró, en vez de asumir éxito solo porque se
// encontró y clickeó *algún* elemento.
function dialogTextStillVisibleJs(textHint) {
  return `
    (function(){
      const isVisible = ${isVisibleJs('el')};
      const all = ${allElementsJs()};
      return !!all.find(el => el.children.length === 0 && new RegExp(${JSON.stringify(textHint)}, 'i').test((el.textContent || '').trim()) && (el.textContent || '').trim().length < 80 && isVisible(el));
    })()
  `;
}

// Respaldo cuando el texto del diálogo no matchea (p.ej. el hint no
// coincide exactamente con el texto real, o el título vive en un
// elemento distinto al que se busca): en vez de depender de encontrar
// primero el TEXTO del diálogo, se busca directamente un botón "OK"
// visible que tenga un botón "Cancel" cerca (mismo contenedor, hasta 4
// niveles arriba) — esa combinación es prácticamente exclusiva de un
// modal de confirmación, así que sirve como detector independiente del
// wording exacto del título.
function findVisibleOkNearCancelJs() {
  return `
    (function(){
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && el.offsetParent !== null;
      };
      const label = b => (b.textContent || b.value || '').trim();
      const all = ${allElementsJs()};
      const candidates = all.filter(b => b.matches && b.matches(${JSON.stringify(CLICKABLE_SELECTOR)}) && isVisible(b));
      const okBtn = candidates.find(b => /^ok$/i.test(label(b)));
      if (!okBtn) return null;
      let container = okBtn.parentElement;
      let hops = 0;
      while (container && hops < 4) {
        const hasCancel = Array.from(container.querySelectorAll(${JSON.stringify(CLICKABLE_SELECTOR)}))
          .some(b => /cancel/i.test(label(b)));
        if (hasCancel) return okBtn;
        container = container.parentElement;
        hops++;
      }
      return null;
    })()
  `;
}

// Antes se asumía éxito apenas se encontraba y clickeaba *algún*
// elemento — eso permitía falsos positivos (click en un botón "OK"
// decorativo de una plantilla oculta, sin ningún efecto real en el
// switch: la app reportaba éxito pero el dispositivo no cambiaba nada).
// Ahora, después de cada click, se verifica que el texto del diálogo
// realmente haya desaparecido de la pantalla antes de dar por
// confirmado — si sigue visible, se reintenta hasta agotar timeoutMs.
async function confirmDialogIfPresent(win, textHint, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const remaining = Math.max(1000, timeoutMs - (Date.now() - start));
    const clicked = await realClick(win, findDialogButtonByTextHintJs(textHint), Math.min(1500, remaining))
      || await realClick(win, findVisibleOkNearCancelJs(), Math.min(1500, remaining));
    if (!clicked) {
      await new Promise(r => setTimeout(r, 300));
      continue;
    }
    await new Promise(r => setTimeout(r, 500));
    const stillThere = await exec(win, dialogTextStillVisibleJs(textHint)).catch(() => true);
    if (!stillThere) return true;
    // El click no tuvo efecto real — reintentar la búsqueda desde cero
    // (puede que haya matcheado el elemento equivocado la primera vez).
  }
  return false;
}

// Confirmado con captura real: después de "Confirm submission?" aparece
// TODAVÍA otro diálogo, "Save Configuration Success." — solo con botón
// OK (sin Cancel), así que findVisibleOkNearCancelJs no lo detecta. En
// vez de agregar un textHint específico más (frágil ante cualquier otro
// wording de "éxito" que use el firmware), se busca genéricamente
// cualquier botón "OK" visible que sea el único control de su fila/caja
// (sin Cancel al lado) — un patrón que identifica un diálogo de aviso
// simple igual de bien que uno de confirmación. Se repite varias veces
// por si hay más de un diálogo encadenado.
function findStandaloneOkJs() {
  return `
    (function(){
      const isVisible = ${isVisibleJs('el')};
      const label = b => (b.textContent || b.value || '').trim();
      const all = ${allElementsJs()};
      const candidates = all.filter(b => b.matches && b.matches(${JSON.stringify(CLICKABLE_SELECTOR)}) && isVisible(b));
      return candidates.find(b => /^ok$/i.test(label(b))) || null;
    })()
  `;
}

async function dismissFollowUpOkDialogs(win, maxDialogs = 3) {
  for (let i = 0; i < maxDialogs; i++) {
    const before = await exec(win, `!!(${findStandaloneOkJs()})`).catch(() => false);
    if (!before) return;
    const clicked = await realClick(win, findStandaloneOkJs(), 1500);
    if (!clicked) return;
    await new Promise(r => setTimeout(r, 600));
  }
}

async function navigateAndWait(win, accessIp) {
  await win.loadURL(`http://${accessIp}/`);
  const loaded = await waitFor(win, `document.querySelector('input') != null || document.body.textContent.length > 40`, 12000, 300);
  if (!loaded) {
    throw new Error(`El switch respondió en ${accessIp} pero el panel no terminó de cargar. Probá de nuevo o revisá la IP de acceso.`);
  }
}

// Sesiones activas: BrowserWindow ya logueado, keyed por accessIp — mismo
// patrón que hikvisionIsapi.js (readAndSecure abre y loguea, applyNetwork
// reutiliza la sesión ya autenticada).
const sessions = new Map();

async function login(win, user, pass) {
  const filled = await exec(win, `
    (function(){
      const userEl = Array.from(document.querySelectorAll('input')).find(i => i.type !== 'password');
      const passEl = Array.from(document.querySelectorAll('input')).find(i => i.type === 'password');
      if (!userEl || !passEl) return false;
      ${setNativeValue('userEl, ' + JSON.stringify(user))};
      ${setNativeValue('passEl, ' + JSON.stringify(pass))};
      return true;
    })()
  `);
  if (!filled) return false;

  await new Promise(r => setTimeout(r, 300));
  const clicked = await clickButton(win, 'Login') || await clickButton(win, 'Log In') || await clickButton(win, 'Iniciar sesión');
  if (!clicked) {
    // Algunos formularios envían con Enter en vez de un botón dedicado.
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  }

  await new Promise(r => setTimeout(r, 1000));
  return true;
}

// El primer login con las credenciales de fábrica (admin/admin) suele
// forzar una pantalla de cambio de contraseña con dos campos (nueva +
// confirmar) antes de dejar entrar al panel real.
async function changePasswordIfPrompted(win, newPass) {
  const hasTwoPasswordFields = await exec(win, `
    Array.from(document.querySelectorAll('input[type=password]')).length >= 2
  `);
  if (!hasTwoPasswordFields) return false;

  const filled = await exec(win, `
    (function(){
      const pwInputs = Array.from(document.querySelectorAll('input[type=password]'));
      if (pwInputs.length < 2) return false;
      ${setNativeValue('pwInputs[0], ' + JSON.stringify(newPass))};
      ${setNativeValue('pwInputs[1], ' + JSON.stringify(newPass))};
      return true;
    })()
  `);
  if (!filled) return false;

  await new Promise(r => setTimeout(r, 300));
  const clicked = await clickButton(win, 'Confirm') || await clickButton(win, 'Apply') || await clickButton(win, 'OK') || await clickButton(win, 'Confirmar');
  if (clicked) {
    // Este paso también puede disparar un diálogo de confirmación.
    await confirmDialogIfPresent(win, 'confirm', 3000);
  }
  await new Promise(r => setTimeout(r, 1200));
  return true;
}

async function readAndSecure({ accessIp, newPass }) {
  if (!accessIp) throw new Error('Falta accessIp');
  if (!newPass) throw new Error('Falta newPass');

  const win = new BrowserWindow({ width: 900, height: 700, show: true });
  win.setMenuBarVisibility(false);

  try {
    await navigateAndWait(win, accessIp);

    const onDashboard = await exec(win, containsTextAnyDocJs('System Summary')).catch(() => false);

    let activated = false;
    if (!onDashboard) {
      await login(win, 'admin', 'admin');
      await new Promise(r => setTimeout(r, 800));

      const promptedChange = await changePasswordIfPrompted(win, newPass);
      if (promptedChange) activated = true;

      const stillNeedsLogin = await exec(win, `!(${containsTextAnyDocJs('System Summary')})`).catch(() => true);
      if (stillNeedsLogin) {
        // Puede que admin/admin ya no sea válido (switch ya configurado
        // antes) — se reintenta con la contraseña objetivo.
        await navigateAndWait(win, accessIp);
        await login(win, 'admin', newPass);
        await new Promise(r => setTimeout(r, 800));
      }
    }

    const reachedDashboard = await waitFor(win, containsTextAnyDocJs('System Summary'), 8000, 300);
    if (!reachedDashboard) {
      const dir = await dumpDiagnostics(win, 'login-stuck');
      throw new Error(`No se pudo iniciar sesión en el switch ni con admin/admin ni con la contraseña nueva. Verificá la IP y que el switch esté en estado de fábrica.${dir ? ` Diagnóstico guardado en: ${dir}` : ''}`);
    }

    const mac = await getFieldByLabel(win, 'MAC Address:');
    const serial = await getFieldByLabel(win, 'Serial Number:');

    sessions.set(accessIp, { win });

    return { ok: true, activated, mac: mac || '', serial: serial || '' };
  } catch (e) {
    win.destroy();
    throw e;
  }
}

async function applyNetwork({ accessIp, deviceName, targetIp, targetMask, targetGateway }) {
  const session = sessions.get(accessIp);
  if (!session) throw new Error('Primero ejecutá el paso de credenciales (readAndSecure) para este switch.');
  const { win } = session;

  try {
    // Paso 1: System Summary → Device Name → Apply.
    if (deviceName) {
      const onSummary = await waitFor(win, containsTextAnyDocJs('System Summary'), 5000, 300);
      if (!onSummary) throw new Error('No se llegó a la pantalla de System Summary.');

      const setName = await setFieldByLabel(win, 'Device Name:', deviceName);
      if (!setName) throw new Error('No se encontró el campo "Device Name" en System Summary.');

      await new Promise(r => setTimeout(r, 300));
      if (!(await clickButton(win, 'Apply'))) {
        throw new Error('No se encontró el botón "Apply" en System Summary.');
      }
      await confirmDialogIfPresent(win, 'confirm', 3000);
      await dismissFollowUpOkDialogs(win);
      await new Promise(r => setTimeout(r, 1000));
    }

    // Paso 2: IP Settings → DHCP off, IP/máscara/gateway, DNS manual → Apply.
    if (targetIp && targetMask) {
      const clickedIpSettings = await clickButton(win, 'IP Settings');
      if (!clickedIpSettings) throw new Error('No se encontró "IP Settings" en el menú del switch.');
      const onIpSettings = await waitFor(win, containsTextAnyDocJs('DHCP Settings'), 5000, 300);
      if (!onIpSettings) throw new Error('No se llegó a la pantalla de IP Settings.');
      await new Promise(r => setTimeout(r, 400));

      if (!(await setFieldByLabel(win, 'DHCP Settings:', 'Disable'))) {
        throw new Error('No se encontró el selector de "DHCP Settings".');
      }
      await new Promise(r => setTimeout(r, 300));

      const ipOk   = await setFieldByLabel(win, 'IP Address:', targetIp);
      const maskOk = await setFieldByLabel(win, 'Subnet Mask:', targetMask);
      if (!ipOk || !maskOk) throw new Error('No se encontraron los campos de IP/Máscara en IP Settings.');
      if (targetGateway) {
        await setFieldByLabel(win, 'Default Gateway:', targetGateway);
      }

      if (!(await setFieldByLabel(win, 'Auto DNS:', 'Disable'))) {
        throw new Error('No se encontró el selector de "Auto DNS".');
      }
      await new Promise(r => setTimeout(r, 300));
      await setFieldByLabel(win, 'DNS Server:', '8.8.8.8');

      await new Promise(r => setTimeout(r, 300));
      if (!(await clickButton(win, 'Apply'))) {
        throw new Error('No se encontró el botón "Apply" en IP Settings.');
      }
      await new Promise(r => setTimeout(r, 800));
      const confirmed = await confirmDialogIfPresent(win, 'confirm', 6000);
      if (!confirmed) {
        // Este diálogo es el que efectivamente dispara el reinicio del
        // switch con los datos nuevos — si no se pudo confirmar, el
        // cambio de IP quedó a medio aplicar en el dispositivo real, así
        // que se trata como error duro (antes se ignoraba en silencio).
        throw new Error('No se pudo confirmar el diálogo "Confirm submission?" en IP Settings — el switch no se reinició con los datos nuevos.');
      }
      // Confirmado con captura real: después de "Confirm submission?"
      // aparece todavía otro diálogo, "Save Configuration Success." —
      // solo con OK, sin Cancel — que también hay que cerrar para que el
      // switch termine de aplicar y reiniciarse.
      await dismissFollowUpOkDialogs(win);
      await new Promise(r => setTimeout(r, 1500));
    }

    sessions.delete(accessIp);
    win.destroy();
    return { ok: true, probablySucceeded: true };
  } catch (e) {
    // Mismo mecanismo que en readAndSecure: si algo de este paso falla,
    // se guarda un screenshot + el HTML visible en ese momento exacto —
    // con eso se puede corregir el selector que corresponda de una,
    // en vez de otra ronda de captura manual + suposición.
    const dir = await dumpDiagnostics(win, 'apply-network-failed').catch(() => null);
    sessions.delete(accessIp);
    try { win.destroy(); } catch (_) {}
    const msg = e.message || String(e);
    return { ok: false, message: dir ? `${msg} Diagnóstico guardado en: ${dir}` : msg };
  }
}

function hasActiveSession() {
  return sessions.size > 0;
}

module.exports = { readAndSecure, applyNetwork, hasActiveSession };
