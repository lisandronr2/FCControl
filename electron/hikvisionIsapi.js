// Configuración de cámaras Hikvision/HikMicro — corre en el proceso
// principal de Electron.
//
// La primera versión de este módulo hablaba HTTP/ISAPI directo (Digest
// Auth). En la práctica, el modelo probado (HikMicro, firmware con portal
// Vue/Element UI) cifra la contraseña de activación con un esquema
// propietario no documentado antes de mandarla a /ISAPI/System/activate —
// reversear ese cifrado a ciegas no es un uso razonable del tiempo.
//
// En cambio, esto abre una BrowserWindow (Chromium completo, con acceso
// directo a la red local igual que el resto de Electron) apuntada al
// panel web real de la cámara, y automatiza esa interfaz — login/activación
// y el asistente de red — exactamente como lo haría un técnico. El cifrado
// lo sigue haciendo el código original de la cámara, que sabemos que
// funciona; nosotros solo completamos campos y apretamos botones.

const { BrowserWindow } = require('electron');

function setNativeValue(js) {
  // Los inputs de Vue/Element UI no detectan cambios hechos con .value = x
  // directo — hay que usar el setter nativo del prototipo y disparar el
  // evento 'input' para que el framework lo registre.
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

function findInputByPlaceholderJs(placeholderSubstr) {
  return `Array.from(document.querySelectorAll('input')).find(i => i.placeholder && i.placeholder.includes(${JSON.stringify(placeholderSubstr)}))`;
}

function findInputByTypeJs(type) {
  return `Array.from(document.querySelectorAll('input')).find(i => i.type === ${JSON.stringify(type)})`;
}

function findButtonByTextJs(text) {
  return `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().includes(${JSON.stringify(text)}))`;
}

// Sesiones activas: BrowserWindow ya logueado, keyed por accessIp
const sessions = new Map();

async function login(win, user, pass) {
  const passInput = findInputByTypeJs('password');
  const filled = await exec(win, `
    (function(){
      const userEl = ${findInputByPlaceholderJs('usuario')};
      const passEl = ${passInput};
      if (!userEl || !passEl) return false;
      ${setNativeValue('userEl, ' + JSON.stringify(user))};
      ${setNativeValue('passEl, ' + JSON.stringify(pass))};
      return true;
    })()
  `);
  if (!filled) return false;

  await new Promise(r => setTimeout(r, 300));
  await exec(win, `
    (function(){
      const btn = ${findButtonByTextJs('Iniciar sesión')};
      if (btn) btn.click();
    })()
  `);

  await waitFor(win, `!location.hash.includes('/login')`, 8000);
  await new Promise(r => setTimeout(r, 800));
  const stillOnLogin = await exec(win, `location.hash.includes('/login')`);
  return !stillOnLogin;
}

async function activate(win, newPass) {
  const filled = await exec(win, `
    (function(){
      const passInputs = Array.from(document.querySelectorAll('input[type=password]'));
      if (passInputs.length < 2) return false;
      ${setNativeValue('passInputs[0], ' + JSON.stringify(newPass))};
      ${setNativeValue('passInputs[1], ' + JSON.stringify(newPass))};
      return true;
    })()
  `);
  if (!filled) return false;

  await new Promise(r => setTimeout(r, 300));
  await exec(win, `
    (function(){
      const btn = ${findButtonByTextJs('Activación')};
      if (btn) btn.click();
    })()
  `);

  await waitFor(win, `!location.hash.includes('/wizard') === false || !document.querySelector('input[type=password]')`, 8000);
  await new Promise(r => setTimeout(r, 1000));
  return true;
}

// Navega y espera activamente a que el panel Vue de la cámara termine de
// montar (no un sleep fijo: en cámaras lentas 1.5s no alcanza), o lanza un
// error específico y accionable en vez de dejar que el flujo siga a ciegas
// y termine confundiendo "la página no cargó" con "contraseña incorrecta".
async function navigateAndWaitForPortal(win, accessIp, path) {
  try {
    await win.loadURL(`http://${accessIp}${path}`);
  } catch (e) {
    throw new Error(`No se pudo conectar con la cámara en ${accessIp} (${e.message}). Verificá la IP y que el teléfono/PC esté en la misma red.`);
  }

  const loaded = await waitFor(win, `document.querySelectorAll('input').length > 0`, 8000, 400);
  if (!loaded) {
    const diag = await exec(win, `JSON.stringify({url: location.href, title: document.title, bodyLen: document.body ? document.body.innerHTML.length : 0})`).catch(() => '{}');
    throw new Error(`La cámara respondió en ${accessIp} pero el panel no terminó de cargar (${diag}). Probá de nuevo o revisá la IP de acceso.`);
  }
}

// El asistente es lineal y de varios pasos: escribir la IP y avanzar UNA
// vez a la siguiente pantalla no alcanza para que la cámara aplique nada
// — confirmado contra hardware real (la contraseña, que se aplica desde
// una pantalla de acción directa, sí quedó puesta; la IP, completada a
// mitad del asistente y luego abandonada, no). Hay que llegar hasta el
// paso final del asistente y confirmarlo ahí. Como no sabemos de
// antemano cuántos pasos quedan ni la etiqueta exacta del botón
// final, se sigue avanzando y buscando en cada pantalla un botón de
// cierre; si no aparece ninguno tras varios pasos, se lo reporta como
// no confirmado en vez de asumir que se aplicó igual.
async function advanceWizardToFinish(win, maxSteps = 6) {
  const FINISH_WORDS = ['Finalizar', 'Completar', 'Terminar', 'Guardar', 'Aplicar', 'Aceptar', 'Confirmar'];
  for (let step = 0; step < maxSteps; step++) {
    const clickedFinish = await exec(win, `
      (function(){
        const words = ${JSON.stringify(FINISH_WORDS)};
        const btn = Array.from(document.querySelectorAll('button')).find(b => {
          const t = b.textContent.trim();
          return words.some(w => t.includes(w));
        });
        if (btn) { btn.click(); return true; }
        return false;
      })()
    `);
    if (clickedFinish) {
      await new Promise(r => setTimeout(r, 1500));
      return true;
    }

    const clickedNext = await exec(win, `
      (function(){
        const btn = ${findButtonByTextJs('Siguiente')};
        if (btn) { btn.click(); return true; }
        return false;
      })()
    `);
    if (!clickedNext) return false; // no hay más botones para avanzar
    await new Promise(r => setTimeout(r, 1200));
  }
  return false;
}

// Busca y clickea un elemento de menú/pestaña por su texto visible exacto
// (los menús de este panel no son <button>, son <li>/<div>/<span> según la
// pantalla) — prioriza el elemento más chico/específico que matchea, para
// no clickear un contenedor grande que también contiene ese texto.
// Matchea por texto de forma tolerante (sin acentos/mayúsculas, exacto
// primero y por "contiene" como respaldo) porque las etiquetas reales del
// panel varían levemente entre lo que el técnico recuerda y lo que
// realmente dice la UI (p. ej. "Ajuste OSD" vs "Ajustes OSD").
function clickMenuTextJs(text) {
  return `
    (function(){
      function norm(s){ return (s||'').trim().toUpperCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, ''); }
      const target = norm(${JSON.stringify(text)});
      const all = Array.from(document.querySelectorAll('li, div, span, a, button, .el-menu-item, .el-tabs__item, [role=tab]'));
      let candidates = all.filter(el => norm(el.textContent) === target);
      if (!candidates.length) candidates = all.filter(el => norm(el.textContent).includes(target));
      candidates.sort((a, b) => a.innerHTML.length - b.innerHTML.length);
      const el = candidates[0];
      if (el) { el.click(); return true; }
      return false;
    })()
  `;
}

async function clickMenuText(win, text) {
  return exec(win, clickMenuTextJs(text));
}

// Clickea el primer botón de "confirmar cambios" que encuentre en la
// pantalla actual — las distintas pantallas de configuración usan
// Guardar/Aceptar/Aplicar/Confirmar según la pantalla.
async function clickSaveButton(win) {
  for (const word of ['Guardar', 'Aceptar', 'Aplicar', 'Confirmar']) {
    const clicked = await exec(win, `(function(){ const btn = ${findButtonByTextJs(word)}; if (btn) { btn.click(); return true; } return false; })()`);
    if (clicked) return true;
  }
  return false;
}

// Pone el nombre del dispositivo en Configuración → Sistema →
// Configuración del Sistema → Información Básica. Es una pantalla de
// configuración normal con su propio botón de guardar que aplica el
// cambio de inmediato (mismo mecanismo que la contraseña, que sabemos que
// funciona) — no hace falta pasar por ningún asistente de varios pasos.
async function setDeviceNameInSystemInfo(win, deviceName) {
  for (const step of ['Configuración', 'Sistema', 'Configuración del Sistema']) {
    if (!(await clickMenuText(win, step))) {
      throw new Error(`No se encontró "${step}" en el panel de la cámara.`);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  await clickMenuText(win, 'Información Básica'); // por si no quedó seleccionada por defecto
  await new Promise(r => setTimeout(r, 500));

  const onPage = await waitFor(win, `document.body.textContent.includes('Nombre de dispositivo')`, 5000);
  if (!onPage) {
    const diag = await exec(win, `JSON.stringify({url: location.href, bodySnippet: document.body.textContent.slice(0,300)})`).catch(() => '{}');
    throw new Error(`No se llegó a la pantalla de Información Básica (${diag}).`);
  }

  const set = await exec(win, `
    (function(){
      function setVal(el, val) {
        if (!el) return false;
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      const items = Array.from(document.querySelectorAll('.el-form-item'));
      const item = items.find(it => {
        const lbl = it.querySelector('label');
        return lbl && lbl.textContent.includes('Nombre de dispositivo');
      });
      const input = item ? item.querySelector('input[type=text]') : null;
      return setVal(input, ${JSON.stringify(deviceName)});
    })()
  `);
  if (!set) throw new Error('No se encontró el campo "Nombre de dispositivo" en Información Básica.');

  await new Promise(r => setTimeout(r, 300));
  if (!(await clickSaveButton(win))) {
    throw new Error('No se encontró un botón para guardar en Información Básica.');
  }
  await new Promise(r => setTimeout(r, 1200));
}

// Pone el nombre OSD (superpuesto en la imagen) en Configuración → Imagen
// → Ajustes OSD → Nombre del Canal, para Canal 1 y Canal 2. El campo trae
// de fábrica "Camera 1"/"Camera 2" — se reemplaza solo la palabra
// "Camera" por el nombre del dispositivo, dejando el número tal cual
// venía (pedido explícito: no reformatear el sufijo).
async function setOsdChannelNames(win, deviceName) {
  for (const step of ['Configuración', 'Imagen', 'Ajustes OSD']) {
    if (!(await clickMenuText(win, step))) {
      throw new Error(`No se encontró "${step}" en el panel de la cámara.`);
    }
    await new Promise(r => setTimeout(r, 800));
  }

  const onPage = await waitFor(win, `
    document.body.textContent.toUpperCase().includes('OSD') ||
    document.body.textContent.toUpperCase().includes('NOMBRE DEL CANAL')
  `, 5000);
  if (!onPage) {
    const diag = await exec(win, `JSON.stringify({url: location.href, bodySnippet: document.body.textContent.slice(0,300)})`).catch(() => '{}');
    throw new Error(`No se llegó a la pantalla de Ajustes OSD (${diag}).`);
  }

  // ¿Cámara de dos canales? Buscamos pestañas/selectores "1"/"2" o
  // "Canal 1"/"Canal 2"/"CH1"/"CH2".
  const channelTabsInfo = await exec(win, `
    (function(){
      const tabs = Array.from(document.querySelectorAll('.el-tabs__item, .el-radio, [role=tab]'));
      const chTabs = tabs.filter(t => /^(canal\\s*)?[12]$|^ch\\s*[12]$/i.test(t.textContent.trim()));
      return chTabs.length;
    })()
  `);

  // Reemplaza solo "Camera" en el valor actual del campo, preservando el
  // resto (típicamente el número de canal) — si por algún motivo el
  // campo no dice "Camera", usa el número de canal detectado como
  // respaldo en vez de perder ese dato.
  const setChannelName = async (fallbackSuffix) => exec(win, `
    (function(){
      function setVal(el, val) {
        if (!el) return false;
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      const items = Array.from(document.querySelectorAll('.el-form-item'));
      let item = items.find(it => {
        const lbl = it.querySelector('label');
        return lbl && lbl.textContent.toUpperCase().includes('NOMBRE DEL CANAL');
      });
      let input = item ? item.querySelector('input[type=text]') : null;
      if (!input) {
        input = Array.from(document.querySelectorAll('input[type=text]'))
          .find(i => i.value && /camera/i.test(i.value));
      }
      if (!input) return false;
      const current = (input.value || '').trim();
      let newVal;
      if (/camera/i.test(current)) {
        newVal = current.replace(/camera/i, ${JSON.stringify(deviceName)});
      } else {
        const m = current.match(/(\\d+)\\s*$/);
        const suffix = m ? m[1] : ${JSON.stringify(fallbackSuffix)};
        newVal = (${JSON.stringify(deviceName)} + ' ' + suffix).trim();
      }
      return setVal(input, newVal);
    })()
  `);

  if (channelTabsInfo >= 2) {
    for (let ch = 1; ch <= 2; ch++) {
      const clicked = await exec(win, `
        (function(){
          const tabs = Array.from(document.querySelectorAll('.el-tabs__item, .el-radio, [role=tab]'));
          const tab = tabs.find(t => new RegExp('^(canal\\\\s*)?${ch}$|^ch\\\\s*${ch}$', 'i').test(t.textContent.trim()));
          if (tab) { tab.click(); return true; }
          return false;
        })()
      `);
      if (!clicked) throw new Error(`No se encontró la pestaña del canal ${ch} en Ajustes OSD.`);
      await new Promise(r => setTimeout(r, 500));
      const set = await setChannelName(String(ch));
      if (!set) throw new Error(`No se encontró el campo "Nombre del Canal" para el canal ${ch}.`);
    }
  } else {
    const set = await setChannelName('');
    if (!set) {
      const diag = await exec(win, `JSON.stringify(Array.from(document.querySelectorAll('.el-form-item label')).map(l => l.textContent.trim()))`).catch(() => '[]');
      throw new Error(`No se encontró el campo "Nombre del Canal" en Ajustes OSD. Etiquetas visibles: ${diag}`);
    }
  }

  await new Promise(r => setTimeout(r, 300));
  if (!(await clickSaveButton(win))) {
    throw new Error('No se encontró un botón para guardar en Ajustes OSD.');
  }
  await new Promise(r => setTimeout(r, 1200));
}

async function readAndSecure({ accessIp, currentUser = 'admin', currentPass = '12345', newPass }) {
  if (!accessIp) throw new Error('Falta accessIp');
  if (!newPass) throw new Error('Falta newPass');

  const win = new BrowserWindow({ width: 900, height: 700, show: true });
  win.setMenuBarVisibility(false);

  try {
    await navigateAndWaitForPortal(win, accessIp, '/doc/index.html#/portal/login');

    // ¿Pantalla de activación de fábrica (dos campos de contraseña) o login normal?
    const isActivationScreen = await exec(win, `document.querySelectorAll('input[type=password]').length >= 2`);

    let activated = false;
    if (isActivationScreen) {
      const ok = await activate(win, newPass);
      if (!ok) throw new Error('No se pudo completar la pantalla de activación de fábrica.');
      activated = true;
      // Tras activar, algunos firmwares loguean automático; si no, probamos login explícito
      const stillNeedsLogin = await exec(win, `location.hash.includes('/login') || document.querySelectorAll('input[type=password]').length >= 2`);
      if (stillNeedsLogin) {
        await navigateAndWaitForPortal(win, accessIp, '/doc/index.html#/portal/login');
        const ok = await login(win, 'admin', newPass);
        if (!ok) throw new Error('La cámara se activó pero no se pudo iniciar sesión después con la contraseña nueva.');
      }
    } else {
      // Login normal: probamos primero con la contraseña "actual" indicada,
      // y si falla, con la contraseña objetivo (por si ya estaba puesta de
      // una configuración previa).
      let ok = await login(win, currentUser, currentPass);
      if (!ok) {
        await navigateAndWaitForPortal(win, accessIp, '/doc/index.html#/portal/login');
        ok = await login(win, currentUser, newPass);
      }
      if (!ok) throw new Error(`No se pudo iniciar sesión en ${accessIp} ni con la contraseña actual ('${currentPass}') ni con la nueva ('${newPass}'). Verificá que sea la IP correcta de esta cámara.`);
    }

    // Con sesión iniciada, la cookie del navegador ya autentica llamadas
    // directas a la ISAPI de solo lectura (confirmado: responde XML plano,
    // sin cifrado, para GETs autenticados por cookie de sesión).
    const netXml = await exec(win, `
      fetch('/ISAPI/System/Network/interfaces', { credentials: 'same-origin' })
        .then(r => r.text()).catch(() => '')
    `);
    const mac = (netXml.match(/<MACAddress>([^<]*)<\/MACAddress>/) || [])[1] || '';
    const currentIpVal = (netXml.match(/<ipAddress>([^<]*)<\/ipAddress>/) || [])[1] || '';
    const currentMask = (netXml.match(/<subnetMask>([^<]*)<\/subnetMask>/) || [])[1] || '';

    sessions.set(accessIp, { win });

    return { ok: true, activated, mac, currentIp: currentIpVal, currentMask, interfaceId: '1' };
  } catch (e) {
    win.destroy();
    throw e;
  }
}

async function applyNetwork({ accessIp, deviceName, targetIp, targetMask, targetGateway }) {
  const session = sessions.get(accessIp);
  if (!session) throw new Error('Primero ejecutá el paso de credenciales (readAndSecure) para esta cámara.');
  const { win } = session;

  try {
    // Orden confirmado por el técnico contra el panel real: primero el
    // nombre del dispositivo (Sistema → Información básica) y el nombre
    // OSD por canal (Imagen → Ajuste OSD, reemplazando "CAMERA") — ambas
    // son pantallas de configuración normal con su propio Guardar que
    // aplica al toque, nada que ver con el asistente rápido. Recién
    // después, el asistente de red (que si es de varios pasos y solo
    // guarda al llegar al final — ver advanceWizardToFinish).
    if (deviceName) {
      await setDeviceNameInSystemInfo(win, deviceName);
      await setOsdChannelNames(win, deviceName);
    }

    await navigateAndWaitForPortal(win, accessIp, '/doc/index.html#/wizard');
    const onWizard = await waitFor(win, `document.querySelector('.el-form-item') != null`, 6000);
    if (!onWizard) throw new Error('No se pudo llegar al asistente de configuración de la cámara.');

    // Si DHCP está activo hay que apagarlo antes de poder escribir una IP
    // fija — los switches/checkboxes de Element UI suelen ignorar el click
    // sobre el <input> nativo (que suele estar oculto); hay que clickear el
    // elemento visual que lo envuelve (.el-switch / .el-checkbox / label).
    // Reintenta unas veces y verifica que realmente haya quedado apagado.
    const dhcpOff = await (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const state = await exec(win, `
          (function(){
            const dhcp = Array.from(document.querySelectorAll('input[type=checkbox]'))
              .find(i => i.closest('.el-form-item') &&
                i.closest('.el-form-item').textContent.toUpperCase().includes('DHCP'));
            if (!dhcp) return 'NOT_FOUND';
            if (!dhcp.checked) return 'OFF';
            const clickable = dhcp.closest('.el-switch') || dhcp.closest('.el-checkbox')
              || dhcp.closest('label') || dhcp;
            clickable.click();
            return 'CLICKED';
          })()
        `);
        if (state === 'OFF') return true;
        if (state === 'NOT_FOUND') return false;
        await new Promise(r => setTimeout(r, 500));
      }
      // Última lectura, por si el último click sí surtió efecto
      return await exec(win, `
        (function(){
          const dhcp = Array.from(document.querySelectorAll('input[type=checkbox]'))
            .find(i => i.closest('.el-form-item') &&
              i.closest('.el-form-item').textContent.toUpperCase().includes('DHCP'));
          return dhcp ? !dhcp.checked : false;
        })()
      `);
    })();
    if (!dhcpOff) {
      throw new Error('No se pudo desactivar el DHCP para poder fijar la IP estática.');
    }
    await new Promise(r => setTimeout(r, 500));

    const ok = await exec(win, `
      (function(){
        function byLabel(sub) {
          const items = Array.from(document.querySelectorAll('.el-form-item'));
          const item = items.find(it => {
            const lbl = it.querySelector('label');
            return lbl && lbl.textContent.includes(sub);
          });
          return item ? item.querySelector('input[type=text]') : null;
        }
        function setVal(el, val) {
          if (!el) return false;
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        const ipEl = byLabel('Dirección IPv4 del dispositivo');
        const maskEl = byLabel('Máscara de subred IPv4');
        const gwEl = byLabel('Pasarela predeterminada IPv4');
        let allOk = setVal(ipEl, ${JSON.stringify(targetIp)}) && setVal(maskEl, ${JSON.stringify(targetMask)});
        if (gwEl && ${JSON.stringify(!!targetGateway)}) setVal(gwEl, ${JSON.stringify(targetGateway || '')});
        return allOk;
      })()
    `);
    if (!ok) throw new Error('No se encontraron los campos de IP/máscara en el asistente.');

    // El resto del asistente (hora, etc.) se deja sin tocar — avanza solo
    // hasta encontrar el paso final y confirmarlo ahí.
    await new Promise(r => setTimeout(r, 500));
    const finished = await advanceWizardToFinish(win);
    if (!finished) {
      throw new Error('Se completaron los campos pero no se encontró el paso final del asistente para confirmarlos — la cámara puede no haber aplicado los cambios. Probá de nuevo o revisalo manualmente en el panel de la cámara.');
    }
    await new Promise(r => setTimeout(r, 1500));

    sessions.delete(accessIp);
    win.destroy();
    return { ok: true, probablySucceeded: true };
  } catch (e) {
    sessions.delete(accessIp);
    try { win.destroy(); } catch (_) {}
    return { ok: false, message: e.message || String(e) };
  }
}

// Usado por el auto-actualizador: no forzar un quitAndInstall mientras hay
// una cámara a mitad de configurar (dejaría la cámara en un estado a medio
// aplicar si se corta la ventana de automatización de golpe).
function hasActiveSession() {
  return sessions.size > 0;
}

module.exports = { readAndSecure, applyNetwork, hasActiveSession };
