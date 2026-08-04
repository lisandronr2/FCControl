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

async function clickNext(win) {
  await exec(win, `(function(){ const btn = ${findButtonByTextJs('Siguiente')}; if (btn) btn.click(); })()`);
  await new Promise(r => setTimeout(r, 1200));
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
  const FINISH_WORDS = ['Finalizar', 'Completar', 'Terminar', 'Guardar', 'Aplicar', 'Confirmar'];
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

// Pone el nombre OSD (superpuesto en la imagen) de la cámara para que
// coincida con el nombre del dispositivo en FCControl. Asume que ya
// estamos parados en el paso de "Ajustes OSD" del asistente (paso 3) —
// solo completa el/los campo(s) de esta pantalla, no navega ni confirma
// nada; el asistente entero se confirma UNA sola vez al final (ver
// applyNetwork) porque el cambio de red demostró contra hardware real que
// no se aplica hasta llegar al paso final y confirmarlo — abandonar el
// asistente a mitad de camino (como hacía la versión anterior, en dos
// pasadas separadas) no guarda nada, ni la red ni el nombre OSD.
//
// No tenemos visibilidad de la pantalla real de "Ajustes OSD" (no se pudo
// probar contra hardware al escribir esto), así que la detección de campos
// es defensiva: si no encuentra con certeza razonable qué escribir, falla
// con un mensaje de diagnóstico en vez de arriesgarse a escribir en el
// campo equivocado.
async function fillOsdStep(win, deviceName) {
  const onOsdStep = await waitFor(win, `
    document.body.textContent.toUpperCase().includes('OSD') ||
    document.body.textContent.toUpperCase().includes('SUPERPOSICI')
  `, 5000);
  if (!onOsdStep) {
    const diag = await exec(win, `JSON.stringify({url: location.href, bodySnippet: document.body.textContent.slice(0,300)})`).catch(() => '{}');
    throw new Error(`No se llegó a la pantalla de Ajustes OSD del asistente (${diag}).`);
  }

  // ¿Cámara de dos canales? Buscamos pestañas/selectores con "1"/"2" o
  // "Canal 1"/"Canal 2"/"CH1"/"CH2" cerca de los campos de nombre.
  const channelTabsInfo = await exec(win, `
    (function(){
      const tabs = Array.from(document.querySelectorAll('.el-tabs__item, .el-radio, [role=tab]'));
      const chTabs = tabs.filter(t => /^(canal\\s*)?[12]$|^ch\\s*[12]$/i.test(t.textContent.trim()));
      return chTabs.length;
    })()
  `);

  const setNameOnCurrentPanel = async (name) => {
    return exec(win, `
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
          if (!lbl) return false;
          const t = lbl.textContent.toUpperCase();
          return t.includes('NOMBRE') || t.includes('OSD') || t.includes('CANAL');
        });
        const input = item ? item.querySelector('input[type=text]') : null;
        return setVal(input, ${JSON.stringify(name)});
      })()
    `);
  };

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
      const set = await setNameOnCurrentPanel(`${deviceName} 0${ch}`);
      if (!set) throw new Error(`No se encontró el campo de nombre OSD para el canal ${ch}.`);
    }
  } else {
    const set = await setNameOnCurrentPanel(deviceName);
    if (!set) {
      const diag = await exec(win, `JSON.stringify(Array.from(document.querySelectorAll('.el-form-item label')).map(l => l.textContent.trim()))`).catch(() => '[]');
      throw new Error(`No se encontró el campo de nombre OSD. Etiquetas visibles en esta pantalla: ${diag}`);
    }
  }

  await new Promise(r => setTimeout(r, 300));
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
    // Un único recorrido continuo del asistente: red (paso 1) → hora (paso
    // 2, sin tocar) → OSD (paso 3) → seguir hasta el paso final y
    // confirmarlo. Antes esto se hacía en dos pasadas separadas (una para
    // el nombre OSD, otra para la red), cada una abandonada a mitad del
    // asistente — confirmado contra hardware real que así NO se aplica
    // nada: el asistente solo guarda los cambios cuando se llega hasta el
    // final y se confirma esa última pantalla.
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

    await new Promise(r => setTimeout(r, 500));
    await clickNext(win); // paso 1 (red) → paso 2 (hora)
    await clickNext(win); // paso 2 (hora, sin tocar) → paso 3 (OSD)

    if (deviceName) {
      await fillOsdStep(win, deviceName);
    }

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
