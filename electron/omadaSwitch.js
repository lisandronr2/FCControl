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

// Busca en TODOS los frames de la ventana, no solo el documento
// principal — lección aprendida automatizando el asistente de red de las
// cámaras Hikvision: un diálogo de confirmación puede vivir en un
// <iframe> propio, y executeJavaScript normal solo corre en el frame de
// nivel superior.
function allFrames(win) {
  try {
    const main = win.webContents.mainFrame;
    const subtree = main.framesInSubtree || [main];
    return subtree.length ? subtree : [main];
  } catch (e) {
    return [];
  }
}

// Confirmado con captura de diagnóstico real: el panel de este switch NO
// es una sola página — es un documento contenedor con el menú lateral en
// el nivel superior y el contenido de cada sección (System Summary, IP
// Settings, ...) cargado dentro de un <iframe name="mainFrame">. Ejecutar
// JS solo en win.webContents (nivel superior) nunca ve esos campos una
// vez que el menú navegó a una sección — hay que probar en todos los
// frames y quedarse con el primero que dé un resultado útil.
async function execAnyFrame(win, script, isSuccess = r => !!r) {
  for (const frame of allFrames(win)) {
    try {
      const result = await frame.executeJavaScript(script);
      if (isSuccess(result)) return result;
    } catch (e) { /* siguiente frame */ }
  }
  return null;
}

async function waitFor(win, conditionJs, timeoutMs = 10000, intervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await execAnyFrame(win, conditionJs);
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
      const all = Array.from(document.querySelectorAll('*'));
      const lbl = all.find(el => el.children.length === 0 && (el.textContent || '').trim().replace(/:\\s*$/, '') === target);
      if (!lbl) return null;
      let cell = lbl;
      let hops = 0;
      while (cell && !cell.nextElementSibling && cell.parentElement && cell.parentElement !== document.body && hops < 5) {
        cell = cell.parentElement;
        hops++;
      }
      return cell ? cell.nextElementSibling : null;
    })()
  `;
}

async function setFieldByLabel(win, labelText, value) {
  return execAnyFrame(win, `
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
  `, r => r === true);
}

async function getFieldByLabel(win, labelText) {
  return execAnyFrame(win, `
    (function(){
      const cell = ${findLabelValueCellJs(labelText)};
      if (!cell) return null;
      const field = (cell.matches && cell.matches('input, select')) ? cell : cell.querySelector('input, select');
      if (field) return (field.value || '').trim();
      return (cell.textContent || '').trim();
    })()
  `, r => r !== null && r !== undefined);
}

// Causa raíz real del login trabado, confirmada con captura de
// diagnóstico: el botón "Login" de esta pantalla NO es un <button> —
// es <input type="submit" value="Login" onclick="return doOnclick();">
// (una página clásica de formulario, ni siquiera React). Buscar solo
// 'button' nunca lo iba a encontrar, sin importar si el click era
// sintético o real — el problema nunca fue "isTrusted", fue el
// selector. Ahora matchea tanto <button>/[role=button] (por
// textContent) como <input type=submit|button> (por su atributo value,
// ya que estos elementos no tienen textContent).
function findButtonByTextJs(text) {
  // Confirmado con captura de diagnóstico real: el menú lateral de este
  // switch ("IP Settings", "System Summary", etc.) son <a> sin href (la
  // navegación la maneja JS propio del panel vía un atributo "url"
  // custom, no un click nativo de enlace) — hay que incluirlos en la
  // búsqueda, si no el buscador de botones nunca los encuentra.
  return `
    (function(){
      const t = ${JSON.stringify(text)};
      const byText = Array.from(document.querySelectorAll('button, [role=button], a'))
        .find(b => b.textContent.trim() === t || b.textContent.trim().includes(t));
      if (byText) return byText;
      return Array.from(document.querySelectorAll('input[type=submit], input[type=button]'))
        .find(i => (i.value || '').trim() === t || (i.value || '').trim().includes(t));
    })()
  `;
}

// TODO CLICK EN ESTE MÓDULO PASA POR ACÁ — nunca btn.click() de JS. Se
// ubica el elemento por DOM (buscando en todos los frames, por si vive
// en un <iframe>) solo para calcular SUS COORDENADAS, y el click en sí
// se hace con sendInputEvent — indistinguible de un click real de mouse
// del sistema operativo. No era la causa del login trabado (ver
// findButtonByTextJs más arriba), pero se mantiene como mecanismo de
// click porque sí hace falta para el diálogo de confirmación tipo
// "Confirm submission?" de la pantalla de IP Settings de este switch.
async function realClick(win, findElJs, timeoutMs = 6000) {
  const findRectJs = `
    (function(){
      const el = ${findElJs};
      if (!el) return null;
      if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) return null;
      return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
    })()
  `;
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
    for (const frame of allFrames(win)) {
      const isTopFrame = frame === win.webContents.mainFrame;
      try {
        if (isTopFrame) {
          // getBoundingClientRect() da coordenadas relativas a la ventana
          // solo para el frame de nivel superior — ahí sí sirve el click
          // real por mouse (sendInputEvent), que es indistinguible de un
          // click de sistema operativo.
          const json = await frame.executeJavaScript(findRectJs);
          if (json) {
            const rect = JSON.parse(json);
            const clickX = Math.round(rect.x + rect.width / 2);
            const clickY = Math.round(rect.y + rect.height / 2);
            win.webContents.sendInputEvent({ type: 'mouseMove', x: clickX, y: clickY });
            win.webContents.sendInputEvent({ type: 'mouseDown', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 60));
            win.webContents.sendInputEvent({ type: 'mouseUp', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 400));
            return true;
          }
        } else {
          // Elemento dentro de un <iframe> anidado (p.ej. "mainFrame" de
          // este switch, donde vive el contenido de cada sección del
          // menú): su getBoundingClientRect() es relativo AL PROPIO
          // iframe, no a la ventana, así que sendInputEvent con esas
          // coordenadas apuntaría al lugar equivocado. Traducir el rect
          // sumando el offset del <iframe> en cada frame padre es
          // innecesario acá: el bug del botón Login nunca fue por clicks
          // no confiables (isTrusted) — fue un selector mal armado (ver
          // findButtonByTextJs) — así que un click de DOM normal dentro
          // del frame donde vive el elemento alcanza.
          const clicked = await frame.executeJavaScript(clickJs);
          if (clicked) {
            await new Promise(r => setTimeout(r, 400));
            return true;
          }
        }
      } catch (e) { /* siguiente frame */ }
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function clickButton(win, text, timeoutMs = 2000) {
  return realClick(win, findButtonByTextJs(text), timeoutMs);
}

// Ya van dos intentos (btn.click() y click real por coordenadas) sin
// lograr pasar de la pantalla de login — en vez de seguir adivinando a
// ciegas una tercera hipótesis, se guarda un screenshot + el HTML visible
// en el momento exacto del fallo, para diagnosticar con datos reales.
async function dumpDiagnostics(win, label) {
  try {
    const dir = path.join(app.getPath('userData'), 'debug');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    const png = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `switch-${label}-${stamp}.png`), png.toPNG());

    // Bug real confirmado en producción: esto antes solo volcaba
    // win.webContents (documento de nivel superior) — el contenido de
    // System Summary/IP Settings/diálogos de confirmación vive dentro del
    // <iframe name="mainFrame">, así que el HTML de nivel superior nunca
    // mostraba lo que realmente falló. Ahora se vuelca CADA frame de la
    // ventana (incluidos los iframes) en un archivo aparte.
    const frames = allFrames(win);
    for (let i = 0; i < frames.length; i++) {
      try {
        const html = await frames[i].executeJavaScript('document.documentElement.outerHTML');
        fs.writeFileSync(path.join(dir, `switch-${label}-${stamp}-frame${i}.html`), html || '');
      } catch (e) { /* frame no accesible, seguir con el resto */ }
    }

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
function findDialogButtonByTextHintJs(textHint) {
  return `
    (function(){
      const all = Array.from(document.querySelectorAll('*'));
      const textEl = all.find(el => el.children.length === 0 && new RegExp(${JSON.stringify(textHint)}, 'i').test((el.textContent || '').trim()) && (el.textContent || '').trim().length < 80);
      if (!textEl) return null;
      let container = textEl.parentElement;
      let hops = 0;
      while (container && container !== document.body && hops < 8) {
        const candidates = Array.from(container.querySelectorAll('button, [role=button], a, input[type=submit], input[type=button]'))
          .filter(b => (b.textContent || b.value || '').trim().length > 0);
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
      const candidates = Array.from(document.querySelectorAll('button, [role=button], a, input[type=submit], input[type=button]'))
        .filter(isVisible);
      const okBtn = candidates.find(b => /^ok$/i.test(label(b)));
      if (!okBtn) return null;
      let container = okBtn.parentElement;
      let hops = 0;
      while (container && hops < 4) {
        const hasCancel = Array.from(container.querySelectorAll('button, [role=button], a, input[type=submit], input[type=button]'))
          .some(b => /cancel/i.test(label(b)));
        if (hasCancel) return okBtn;
        container = container.parentElement;
        hops++;
      }
      return null;
    })()
  `;
}

async function confirmDialogIfPresent(win, textHint, timeoutMs = 6000) {
  const byText = await realClick(win, findDialogButtonByTextHintJs(textHint), timeoutMs);
  if (byText) return true;
  return realClick(win, findVisibleOkNearCancelJs(), 2000);
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

    const onDashboard = await exec(win, `document.body.textContent.includes('System Summary')`).catch(() => false);

    let activated = false;
    if (!onDashboard) {
      await login(win, 'admin', 'admin');
      await new Promise(r => setTimeout(r, 800));

      const promptedChange = await changePasswordIfPrompted(win, newPass);
      if (promptedChange) activated = true;

      const stillNeedsLogin = await exec(win, `
        !document.body.textContent.includes('System Summary')
      `).catch(() => true);
      if (stillNeedsLogin) {
        // Puede que admin/admin ya no sea válido (switch ya configurado
        // antes) — se reintenta con la contraseña objetivo.
        await navigateAndWait(win, accessIp);
        await login(win, 'admin', newPass);
        await new Promise(r => setTimeout(r, 800));
      }
    }

    const reachedDashboard = await waitFor(win, `document.body.textContent.includes('System Summary')`, 8000, 300);
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
      const onSummary = await waitFor(win, `document.body.textContent.includes('System Summary')`, 5000, 300);
      if (!onSummary) throw new Error('No se llegó a la pantalla de System Summary.');

      const setName = await setFieldByLabel(win, 'Device Name:', deviceName);
      if (!setName) throw new Error('No se encontró el campo "Device Name" en System Summary.');

      await new Promise(r => setTimeout(r, 300));
      if (!(await clickButton(win, 'Apply'))) {
        throw new Error('No se encontró el botón "Apply" en System Summary.');
      }
      await confirmDialogIfPresent(win, 'confirm', 3000);
      await new Promise(r => setTimeout(r, 1000));
    }

    // Paso 2: IP Settings → DHCP off, IP/máscara/gateway, DNS manual → Apply.
    if (targetIp && targetMask) {
      const clickedIpSettings = await clickButton(win, 'IP Settings');
      if (!clickedIpSettings) throw new Error('No se encontró "IP Settings" en el menú del switch.');
      const onIpSettings = await waitFor(win, `document.body.textContent.includes('DHCP Settings')`, 5000, 300);
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
