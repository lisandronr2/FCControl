// Configuración de switches TP-Link Omada (standalone, sin controlador) —
// corre en el proceso principal de Electron, mismo patrón que
// hikvisionIsapi.js: abre una BrowserWindow apuntada al panel web real del
// switch y lo automatiza como lo haría un técnico (login, cambio de
// contraseña forzado, System Summary, IP Settings).
//
// Dispositivos de nombre ARMxx en el Sheet son switches (IES210GPP u
// similar) en vez de cámaras — index.html decide qué módulo llamar según
// el nombre del dispositivo.

const { BrowserWindow } = require('electron');

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

async function waitFor(win, conditionJs, timeoutMs = 10000, intervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await exec(win, conditionJs);
    if (ok) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
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

function findInputByLabelJs(labelText) {
  // Los formularios de Omada son filas "label a la izquierda, input a la
  // derecha" sin agrupación semántica clara (no hay <label for=...>) — se
  // busca el texto de la etiqueta y se toma el input/select más cercano
  // en la misma fila.
  return `
    (function(){
      const all = Array.from(document.querySelectorAll('*'));
      const lbl = all.find(el => el.children.length === 0 && (el.textContent || '').trim() === ${JSON.stringify(labelText)});
      if (!lbl) return null;
      let row = lbl;
      for (let i = 0; i < 5 && row; i++) {
        const field = row.querySelector('input, select');
        if (field) return field;
        row = row.parentElement;
      }
      return null;
    })()
  `;
}

async function setFieldByLabel(win, labelText, value) {
  return exec(win, `
    (function(){
      const field = ${findInputByLabelJs(labelText)};
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
  `);
}

async function getFieldByLabel(win, labelText) {
  return exec(win, `
    (function(){
      const field = ${findInputByLabelJs(labelText)};
      return field ? (field.value || '').trim() : null;
    })()
  `);
}

function findButtonByTextJs(text) {
  return `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)} || b.textContent.trim().includes(${JSON.stringify(text)}))`;
}

async function clickButton(win, text) {
  return exec(win, `
    (function(){
      const btn = ${findButtonByTextJs(text)};
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);
}

// Diálogos de confirmación tipo "Confirm submission?" (OK/Cancel) — mismo
// enfoque que confirmRebootDialogIfPresent en hikvisionIsapi.js: un click
// disparado por JS (btn.click()) puede ser ignorado por apps que solo
// aceptan eventos de confianza (event.isTrusted). Se ubica el botón por
// DOM solo para calcular SUS COORDENADAS, y el click real se hace con
// sendInputEvent (indistinguible de un click real de mouse del sistema).
async function confirmDialogIfPresent(win, textHint, timeoutMs = 6000) {
  const findRectJs = `
    (function(){
      const all = Array.from(document.querySelectorAll('*'));
      const textEl = all.find(el => el.children.length === 0 && new RegExp(${JSON.stringify(textHint)}, 'i').test((el.textContent || '').trim()) && (el.textContent || '').trim().length < 80);
      if (!textEl) return null;
      let container = textEl.parentElement;
      while (container && container !== document.body && !container.querySelector('button')) {
        container = container.parentElement;
      }
      if (!container) return null;
      const buttons = Array.from(container.querySelectorAll('button')).filter(b => (b.textContent || '').trim().length > 0);
      if (!buttons.length) return null;
      const btn = buttons.find(b => !/cancel/i.test((b.textContent || '').trim())) || buttons[0];
      const r = btn.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) return null;
      return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
    })()
  `;

  const start = Date.now();
  let rect = null;
  while (Date.now() - start < timeoutMs) {
    for (const frame of allFrames(win)) {
      try {
        const json = await frame.executeJavaScript(findRectJs);
        if (json) { rect = JSON.parse(json); break; }
      } catch (e) { /* siguiente frame */ }
    }
    if (rect) break;
    await new Promise(r => setTimeout(r, 300));
  }
  if (!rect) return false;

  const clickX = Math.round(rect.x + rect.width / 2);
  const clickY = Math.round(rect.y + rect.height / 2);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: clickX, y: clickY });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: clickX, y: clickY, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 60));
  win.webContents.sendInputEvent({ type: 'mouseUp', x: clickX, y: clickY, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 800));
  return true;
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
      throw new Error('No se pudo iniciar sesión en el switch ni con admin/admin ni con la contraseña nueva. Verificá la IP y que el switch esté en estado de fábrica.');
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
      const confirmed = await confirmDialogIfPresent(win, 'confirm', 5000);
      if (!confirmed) {
        // Algunos firmwares aplican la IP sin pedir confirmación extra —
        // no se trata como error duro, solo se deja constancia.
        console.warn(`Switch ${accessIp}: no apareció diálogo de confirmación al aplicar IP Settings (puede ser normal en este firmware).`);
      }
      await new Promise(r => setTimeout(r, 1500));
    }

    sessions.delete(accessIp);
    win.destroy();
    return { ok: true, probablySucceeded: true };
  } catch (e) {
    sessions.delete(accessIp);
    try { win.destroy(); } catch (_) {}
    return { ok: false, message: e.message || String(e) };
  }
}

function hasActiveSession() {
  return sessions.size > 0;
}

module.exports = { readAndSecure, applyNetwork, hasActiveSession };
