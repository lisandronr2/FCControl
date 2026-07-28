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

async function readAndSecure({ accessIp, currentUser = 'admin', currentPass = '12345', newPass }) {
  if (!accessIp) throw new Error('Falta accessIp');
  if (!newPass) throw new Error('Falta newPass');

  const win = new BrowserWindow({ width: 900, height: 700, show: true });
  win.setMenuBarVisibility(false);

  try {
    await win.loadURL(`http://${accessIp}/doc/index.html#/portal/login`);
    await new Promise(r => setTimeout(r, 1500));

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
        await win.loadURL(`http://${accessIp}/doc/index.html#/portal/login`);
        await new Promise(r => setTimeout(r, 1500));
        await login(win, 'admin', newPass);
      }
    } else {
      // Login normal: probamos primero con la contraseña "actual" indicada,
      // y si falla, con la contraseña objetivo (por si ya estaba puesta de
      // una configuración previa).
      let ok = await login(win, currentUser, currentPass);
      if (!ok) {
        await win.loadURL(`http://${accessIp}/doc/index.html#/portal/login`);
        await new Promise(r => setTimeout(r, 1500));
        ok = await login(win, currentUser, newPass);
      }
      if (!ok) throw new Error('No se pudo iniciar sesión con la contraseña actual ni con la nueva.');
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

async function applyNetwork({ accessIp, targetIp, targetMask, targetGateway }) {
  const session = sessions.get(accessIp);
  if (!session) throw new Error('Primero ejecutá el paso de credenciales (readAndSecure) para esta cámara.');
  const { win } = session;

  try {
    await win.loadURL(`http://${accessIp}/doc/index.html#/wizard`);
    await waitFor(win, `location.hash.includes('/wizard')`, 6000);
    await new Promise(r => setTimeout(r, 1000));

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
    await exec(win, `
      (function(){
        const btn = ${findButtonByTextJs('Siguiente')};
        if (btn) btn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 2500));

    sessions.delete(accessIp);
    win.destroy();
    return { ok: true, probablySucceeded: true };
  } catch (e) {
    sessions.delete(accessIp);
    try { win.destroy(); } catch (_) {}
    return { ok: false, message: e.message || String(e) };
  }
}

module.exports = { readAndSecure, applyNetwork };
