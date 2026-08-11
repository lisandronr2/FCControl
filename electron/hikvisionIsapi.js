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
  // Prioriza "Siguiente" cuando existe: que ese botón esté presente es la
  // señal más confiable de "todavía no es el paso final". Buscar palabras
  // de cierre (Guardar/Aplicar/Aceptar/etc.) ANTES que "Siguiente" — como
  // hacía la versión anterior — es lo que causaba que el wizard se diera
  // por "terminado" prematuramente: pasos intermedios de este asistente
  // también pueden tener botones con esas palabras genéricas (ej. un
  // "Aplicar" de una sub-sección), y clickear ese en vez del de cierre
  // real deja el cambio de IP sin aplicar aunque el código reporte éxito.
  const FINISH_WORDS = ['Finalizar', 'Completar', 'Terminar', 'Guardar', 'Aplicar', 'Aceptar', 'Confirmar'];
  for (let step = 0; step < maxSteps; step++) {
    const clickedNext = await exec(win, `
      (function(){
        const btn = ${findButtonByTextJs('Siguiente')};
        if (btn) { btn.click(); return true; }
        return false;
      })()
    `);
    if (clickedNext) {
      await new Promise(r => setTimeout(r, 1200));
      continue;
    }

    // No hay "Siguiente" visible — recién ahí se asume que este es el
    // paso final y se busca el botón que realmente confirma los cambios.
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
    return false; // ni "Siguiente" ni un botón de cierre — no hay más por dónde avanzar
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
function clickMenuTextJs(textOrVariants, opts = {}) {
  // Acepta un string o un array de variantes equivalentes (ej. "Ajustes
  // OSD" / "Ajuste OSD" — no siempre se sabe de antemano si el firmware
  // usa singular o plural) y clickea la primera que encuentre.
  const variants = Array.isArray(textOrVariants) ? textOrVariants : [textOrVariants];
  // excludeTabs: el sidebar de navegación reutiliza nombres que también
  // existen como pestañas de contenido en otras pantallas (ej. "Imagen"
  // es a la vez una sección del sidebar de Configuración Y una pestaña
  // dentro de Vídeo/Imagen en Configuración común). Cuando estamos
  // navegando el sidebar, se descartan candidatos que sean pestañas
  // (role=tab / .el-tabs__item) para no terminar clickeando la pestaña
  // equivocada por simple coincidencia de texto.
  const excludeTabs = !!opts.excludeTabs;
  return `
    (function(){
      function norm(s){ return (s||'').trim().toUpperCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, ''); }
      // Los íconos del riel lateral (Configuración, etc.) no siempre tienen
      // texto visible — la etiqueta suele estar en title/aria-label del
      // propio elemento o de un ancestro cercano (wrapper del ícono).
      function labelOf(el){
        let s = el.textContent || '';
        let node = el;
        for (let i = 0; i < 3 && node; i++){
          s += ' ' + (node.getAttribute && (node.getAttribute('title') || node.getAttribute('aria-label') || '') || '');
          node = node.parentElement;
        }
        return s;
      }
      function isTab(el){
        return el.getAttribute('role') === 'tab' || (el.className && String(el.className).includes('tabs__item'));
      }
      const targets = ${JSON.stringify(variants)}.map(norm);
      let all = Array.from(document.querySelectorAll('li, div, span, a, button, i, svg, .el-menu-item, .el-tabs__item, [role=tab], [title], [aria-label], [class]'));
      if (${JSON.stringify(excludeTabs)}) all = all.filter(el => !isTab(el));
      let candidates = all.filter(el => targets.includes(norm(el.textContent)));
      if (!candidates.length) candidates = all.filter(el => { const t = norm(el.textContent); return targets.some(tg => t.includes(tg)); });
      if (!candidates.length) candidates = all.filter(el => { const t = norm(labelOf(el)); return targets.some(tg => t.includes(tg)); });
      candidates.sort((a, b) => a.innerHTML.length - b.innerHTML.length);
      const el = candidates[0];
      if (el) { el.click(); return true; }
      return false;
    })()
  `;
}

async function clickMenuText(win, text, opts) {
  return exec(win, clickMenuTextJs(text, opts));
}

// Clickea específicamente el ícono de la rueda dentada (abre el panel de
// Configuración). Va por fuera de clickMenuTextJs a propósito: ese
// buscador genérico prioriza coincidencias de texto, y el sidebar de
// Configuración trae un ítem llamado literalmente "Configuración común"
// — su texto CONTIENE la palabra "Configuración" como substring, así que
// si ese sidebar ya está abierto (sesión reutilizada de un intento
// anterior) el matcher genérico terminaba clickeando "Configuración
// común" en vez del ícono, dejando la automatización varada en esa
// pantalla. El ícono en sí no tiene texto/title/aria-label confiable, así
// que se ubica únicamente por palabras clave en su clase CSS.
function clickSettingsGearJs() {
  return `
    (function(){
      const keywords = ['setting', 'config', 'gear', 'cog'];
      let candidates = Array.from(document.querySelectorAll('[class]')).filter(el => {
        const cls = (el.getAttribute('class') || '').toLowerCase();
        return keywords.some(k => cls.includes(k));
      });
      candidates.sort((a, b) => a.innerHTML.length - b.innerHTML.length);
      const el = candidates[0];
      if (el) { el.click(); return true; }
      return false;
    })()
  `;
}

async function clickSettingsGear(win) {
  return exec(win, clickSettingsGearJs());
}

// Genera una condición JS que busca `needle` en el texto del panel
// ignorando mayúsculas/minúsculas y acentos — misma normalización que usa
// clickMenuTextJs para encontrar el elemento a clickear.
function bodyIncludesJs(needle) {
  const norm = s => (s || '').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return `document.body.textContent.toUpperCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').includes(${JSON.stringify(norm(needle))})`;
}

// Igual que bodyIncludesJs pero mirando location.hash — la ruta interna
// (ej. "#/config/system/systemSetting/basicInfo") en vez del texto
// visible del panel.
function hashIncludesJs(needle) {
  return `location.hash.toUpperCase().includes(${JSON.stringify(needle.toUpperCase())})`;
}

// Un solo click no siempre "pega" (una transición CSS, un toast de "Guardado"
// tapando el ítem un instante, etc.) — en vez de asumir que funcionó y recién
// fallar varios pasos después con un error confuso, se verifica que el click
// realmente haya llevado a la pantalla esperada y, si no, se reintenta.
//
// IMPORTANTE (bug real encontrado en producción): el sidebar de
// Configuración de esta cámara es ESTÁTICO — "Sistema" siempre muestra
// sus subítems ("Configuración del sistema", "Administración de
// cuentas") como texto, esté o no esa sección activa en el panel
// principal. Verificar contra texto del sidebar (document.body.textContent)
// para saber si una navegación "pegó" es inválido: ese texto ya está
// presente ANTES de clickear, así que una verificación basada en texto
// del sidebar siempre da falso positivo y el click real nunca llega a
// pasar — la URL se queda en la pantalla anterior aunque el código crea
// que avanzó. La señal confiable de que sí se navegó es el cambio de
// location.hash (la SPA cambia de ruta interna al cambiar de sección),
// así que cada intento captura el hash ANTES del click y exige que haya
// cambiado, además de cualquier verifyJs adicional que se le pase.
async function clickVerified(win, clickFn, verifyJs, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const beforeHash = await exec(win, 'location.hash').catch(() => null);
    const clicked = await clickFn();
    if (clicked) {
      const hashChanged = await waitFor(win, `location.hash !== ${JSON.stringify(beforeHash)}`, 2000, 150);
      if (!verifyJs) {
        if (hashChanged) return true;
      } else {
        const ok = await waitFor(win, verifyJs, 2500, 200);
        if (ok) return true;
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function clickMenuTextVerified(win, text, verifyJs, attempts = 3, opts) {
  return clickVerified(win, () => clickMenuText(win, text, opts), verifyJs, attempts);
}

async function clickSettingsGearVerified(win, verifyJs, attempts = 3) {
  return clickVerified(win, () => clickSettingsGear(win), verifyJs, attempts);
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

// ---------------------------------------------------------------------
// ISAPI directo (GET/PUT XML), reutilizando la sesión ya autenticada
// ---------------------------------------------------------------------
// Automatizar el DOM del portal (arriba) es necesariamente frágil: cada
// vez que HikMicro cambia un texto, una clase CSS o cómo se renderiza el
// sidebar, hay que salir a parchear. La propia ISAPI (API REST/XML nativa
// de Hikvision) es mucho más estable porque es un contrato versionado,
// no una UI. Ya se había descartado hablarle ISAPI para la ACTIVACIÓN de
// fábrica (ver comentario al inicio del archivo: la contraseña va cifrada
// con un esquema propietario no reverseado) — pero para una cámara YA
// activada y logueada, no hace falta ese cifrado: alcanza con la cookie
// de sesión que el propio login del portal ya deja puesta en la
// BrowserWindow. Esto está confirmado en este mismo archivo desde antes
// (ver readAndSecure): un fetch('/ISAPI/...', {credentials:'same-origin'})
// autenticado por cookie ya devuelve XML plano sin cifrado.
//
// Se ejecuta vía executeJavaScript en la BrowserWindow (no con el módulo
// http de Node) a propósito: reutiliza la autenticación por cookie ya
// probada en vez de reimplementar Digest Auth a ciegas sin cámara real
// contra la cual validarlo — HTTP Digest tiene suficientes variantes
// (qop, algorithm=MD5-sess, manejo de nc/cnonce) como para que una
// implementación no probada en hardware real sea un riesgo, sobre todo
// para el paso de red (una IP mal aplicada puede dejar la cámara
// inaccesible).
async function isapiFetch(win, method, path, bodyXml) {
  const script = `
    fetch(${JSON.stringify(path)}, {
      method: ${JSON.stringify(method)},
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/xml' }
      ${bodyXml ? `, body: ${JSON.stringify(bodyXml)}` : ''}
    }).then(async r => ({ status: r.status, text: await r.text() }))
      .catch(e => ({ status: 0, text: String(e && e.message || e) }))
  `;
  return exec(win, script);
}

async function isapiGetXml(win, path) {
  const res = await isapiFetch(win, 'GET', path);
  if (res.status !== 200) throw new Error(`ISAPI GET ${path} falló (status ${res.status}): ${(res.text || '').slice(0, 300)}`);
  return res.text;
}

async function isapiPutXml(win, path, xml) {
  const res = await isapiFetch(win, 'PUT', path, xml);
  if (res.status !== 200) throw new Error(`ISAPI PUT ${path} falló (status ${res.status}): ${(res.text || '').slice(0, 300)}`);
  // Hikvision puede devolver HTTP 200 con un <ResponseStatus> que indica
  // fallo lógico adentro (statusCode != 1, ej. parámetro inválido o
  // rechazado por el firmware) — un 200 crudo NO alcanza como prueba de
  // que el cambio realmente se aplicó.
  const statusCode = readXmlTag(res.text, 'statusCode');
  if (statusCode && statusCode !== '1') {
    const statusString = readXmlTag(res.text, 'statusString') || '';
    throw new Error(`ISAPI PUT ${path} rechazado por la cámara (statusCode ${statusCode} ${statusString}): ${(res.text || '').slice(0, 300)}`);
  }
  return res.text;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// La mayoría de los PUT de ISAPI exigen el documento completo (no un
// patch parcial) — muchos firmwares interpretan campos ausentes como "sí,
// bórralos"/"restaurar default" en vez de "dejar como estaba". Por eso el
// patrón siempre es: GET del XML actual → reemplazar solo la etiqueta que
// nos interesa con una regex simple (sin agregar un parser XML como
// dependencia nueva, dado que ISAPI devuelve XML plano y poco anidado) →
// PUT del documento modificado completo.
function replaceXmlTag(xml, tag, value) {
  const re = new RegExp(`(<${tag}>)[^<]*(</${tag}>)`);
  if (!re.test(xml)) throw new Error(`No se encontró la etiqueta <${tag}> en la respuesta ISAPI de la cámara.`);
  return xml.replace(re, `$1${escapeXml(value)}$2`);
}

function readXmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}

// Reemplaza <childTag> solo dentro del primer bloque <parentTag>...
// </parentTag> — necesario cuando el mismo nombre de etiqueta aparece más
// de una vez en el documento en distintos contextos (ej. <ipAddress>
// aparece tanto a nivel raíz como anidado dentro de <DefaultGateway>).
function replaceXmlTagScoped(xml, parentTag, childTag, value) {
  const parentRe = new RegExp(`<${parentTag}>[\\s\\S]*?</${parentTag}>`);
  const m = xml.match(parentRe);
  if (!m) throw new Error(`No se encontró <${parentTag}> en la respuesta ISAPI de la cámara.`);
  return xml.replace(parentRe, replaceXmlTag(m[0], childTag, value));
}

// PUT /ISAPI/System/deviceInfo — mismo campo que el DOM cambia en
// Sistema → Configuración del Sistema → Información Básica → Nombre de
// dispositivo.
async function isapiSetDeviceName(win, deviceName) {
  const path = '/ISAPI/System/deviceInfo';
  const current = await isapiGetXml(win, path);
  const updated = replaceXmlTag(current, 'deviceName', deviceName);
  await isapiPutXml(win, path, updated);
}

// PUT /ISAPI/System/Video/inputs/channels/{id}/overlay — mismo campo que
// el DOM cambia en Imagen → Ajuste OSD → Canal N → Nombre del Canal.
// Igual criterio que la versión DOM: si el valor actual trae "Camera"
// (de fábrica, ej. "Camera 01"), se reemplaza solo esa palabra
// preservando el sufijo numérico tal cual venía; si no matchea ese
// patrón, se arma un nombre nuevo con el número de canal.
async function isapiSetChannelOsdName(win, channelId, deviceName) {
  const path = `/ISAPI/System/Video/inputs/channels/${channelId}/overlay`;
  const current = await isapiGetXml(win, path);
  const parentMatch = current.match(/<channelNameOverlay>[\s\S]*?<\/channelNameOverlay>/);
  if (!parentMatch) throw new Error(`No se encontró channelNameOverlay en el canal ${channelId}.`);
  const currentName = readXmlTag(parentMatch[0], 'name') || '';
  const newName = /camera/i.test(currentName)
    ? currentName.replace(/camera/i, deviceName)
    : `${deviceName} ${channelId}`;
  const updated = replaceXmlTagScoped(current, 'channelNameOverlay', 'name', newName);
  await isapiPutXml(win, path, updated);
}

// Cuántos canales de video expone la cámara (1 para modelos simples, 2
// para los dual-lens que motivan setOsdChannelNames en la versión DOM).
async function isapiListChannelIds(win) {
  try {
    const xml = await isapiGetXml(win, '/ISAPI/System/Video/inputs/channels');
    const ids = Array.from(xml.matchAll(/<id>([^<]*)<\/id>/g)).map(m => m[1]);
    return ids.length ? ids : ['1'];
  } catch (_) {
    return ['1'];
  }
}

// PUT /ISAPI/System/Network/interfaces/{id}/ipAddress — mismo paso que el
// asistente de red del DOM (advanceWizardToFinish). El orden de campos
// típico de este endpoint en firmwares Hikvision es ipVersion, ipAddress,
// subnetMask, ..., DefaultGateway → <ipAddress> raíz aparece ANTES que el
// anidado en DefaultGateway, así que replaceXmlTag (que reemplaza solo la
// primera ocurrencia) alcanza para el campo raíz sin necesidad de scope;
// el de gateway sí se resuelve con replaceXmlTagScoped para no tocar el
// de arriba por error.
async function isapiSetNetwork(win, interfaceId, { ip, mask, gateway }) {
  const path = `/ISAPI/System/Network/interfaces/${interfaceId}/ipAddress`;
  let current = await isapiGetXml(win, path);
  // Causa real confirmada en producción de "la cámara acepta el cambio
  // pero sigue reportando la IP vieja": si la interfaz sigue en DHCP
  // (<addressingType>dynamic</addressingType>, default de fábrica),
  // escribir <ipAddress> a mano no tiene ningún efecto — la propia UI del
  // portal ya maneja esto (ver dhcpOff en el flujo DOM, más abajo) pero
  // el camino ISAPI se lo había salteado. Forzar a "static" en el mismo
  // PUT es el equivalente ISAPI de apagar el switch de DHCP del asistente.
  if (current.includes('<addressingType>')) {
    current = replaceXmlTag(current, 'addressingType', 'static');
  }
  current = replaceXmlTag(current, 'ipAddress', ip);
  current = replaceXmlTag(current, 'subnetMask', mask);
  if (gateway) {
    current = replaceXmlTagScoped(current, 'DefaultGateway', 'ipAddress', gateway);
  }
  await isapiPutXml(win, path, current);
  await verifyNetworkApplied(win, path, ip);
}

// La cámara puede aceptar un PUT de red (HTTP 200 + statusCode 1) y aun
// así no aplicar el cambio — confirmado en producción que "la app dice
// que cambió la IP" no era prueba suficiente: la cámara seguía
// reportando la IP de fábrica. Se relee el valor guardado y se compara
// contra lo pedido antes de dar el paso por exitoso. Si el GET de
// verificación falla (ej. porque la interfaz ya cambió de IP y el fetch
// same-origin dejó de resolver), NO se trata como fallo duro — es la
// señal esperada de un cambio que sí surtió efecto.
async function verifyNetworkApplied(win, path, expectedIp) {
  await new Promise(r => setTimeout(r, 800));
  let after;
  try {
    after = await isapiGetXml(win, path);
  } catch (_) {
    return; // no se pudo releer — probablemente porque sí cambió de IP
  }
  const appliedIp = readXmlTag(after, 'ipAddress');
  if (appliedIp && appliedIp !== expectedIp) {
    throw new Error(`La cámara aceptó el cambio pero sigue reportando la IP ${appliedIp} en vez de ${expectedIp} — no se aplicó de verdad.`);
  }
}

// Intenta el flujo completo por ISAPI directo. Se prueba ANTES que la
// automatización DOM porque, si el firmware acepta este esquema de XML,
// es más rápido y no depende de que la UI del portal no haya cambiado —
// pero como no hay forma de validar el esquema exacto de XML contra
// hardware real desde acá, cualquier fallo (404 de un endpoint que no
// existe en este firmware, un nombre de etiqueta distinto, etc.) hace
// caer TODO el bloque para no dejar la cámara a medio configurar por una
// mezcla de dos mecanismos distintos — y quien llama debe hacer fallback
// completo a la secuencia DOM ya probada.
async function tryIsapiFullFlow(win, { deviceName, targetIp, targetMask, targetGateway }) {
  if (deviceName) {
    await isapiSetDeviceName(win, deviceName);
    const channelIds = await isapiListChannelIds(win);
    for (const id of channelIds) {
      await isapiSetChannelOsdName(win, id, deviceName);
    }
  }
  if (targetIp && targetMask) {
    await isapiSetNetwork(win, '1', { ip: targetIp, mask: targetMask, gateway: targetGateway });
  }
}

// Pone el nombre del dispositivo en Configuración → Sistema →
// Configuración del Sistema → Información Básica. Es una pantalla de
// configuración normal con su propio botón de guardar que aplica el
// cambio de inmediato (mismo mecanismo que la contraseña, que sabemos que
// funciona) — no hace falta pasar por ningún asistente de varios pasos.
async function setDeviceNameInSystemInfo(win, deviceName) {
  if (!(await clickSettingsGearVerified(win, hashIncludesJs('config')))) {
    throw new Error('No se encontró el ícono de "Configuración" (rueda dentada) en el panel de la cámara.');
  }
  await new Promise(r => setTimeout(r, 500));

  // "Sistema" SÍ es clickeable (confirmado por el técnico contra la
  // cámara real): despliega el acordeón que revela "Configuración del
  // sistema" / "Administración de cuentas". La navegación por hash que se
  // usa para el paso siguiente NO sirve acá porque desplegar un acordeón
  // no cambia location.hash — solo cambia qué texto es visible en el
  // sidebar — por eso este paso puntual verifica por texto (normalizado,
  // sin distinguir mayúsculas/acentos) en vez de por hash.
  if (!(await clickMenuTextVerified(win, 'Sistema', `${bodyIncludesJs('Configuración del sistema')} || ${bodyIncludesJs('Administración de cuentas')}`, 3, { excludeTabs: true }))) {
    throw new Error('No se encontró "Sistema" en el panel de la cámara.');
  }
  await new Promise(r => setTimeout(r, 500));

  // "Configuración del Sistema" sí navega de verdad (cambia location.hash
  // a algo con "systemsetting", confirmado en captura real de la cámara).
  if (!(await clickMenuTextVerified(win, 'Configuración del Sistema', `${hashIncludesJs('systemsetting')} || ${bodyIncludesJs('Nombre de dispositivo')}`, 3, { excludeTabs: true }))) {
    throw new Error('No se encontró "Configuración del Sistema" en el panel de la cámara.');
  }
  await new Promise(r => setTimeout(r, 500));
  await clickMenuText(win, 'Información Básica'); // por si no quedó seleccionada por defecto
  await new Promise(r => setTimeout(r, 500));

  const onPage = await waitFor(win, bodyIncludesJs('Nombre de dispositivo'), 5000);
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

// Pone el nombre OSD (superpuesto en la imagen) en Imagen → Ajustes OSD
// → Nombre del canal, para Canal 1 y Canal 2. El campo trae de fábrica
// "Camera 01"/"Camera 02" — se reemplaza solo la palabra "Camera" por el
// nombre del dispositivo, dejando el número tal cual venía (pedido
// explícito: no reformatear el sufijo).
//
// Confirmado con captura real de la cámara (con preview en vivo del
// overlay, campo "Nombre del canal" = "Camera 01"): "Imagen" es un ítem
// del SIDEBAR (no una pestaña de Configuración común, como se había
// asumido por error en un intento anterior) y "Ajustes OSD" es una
// pestaña dentro de esa pantalla, junto a Mostrar ajustes/Máscara de
// privacidad/Superposición de imágenes/etc.
async function setOsdChannelNames(win, deviceName) {
  // Este es el SEGUNDO click sobre la rueda dentada en la misma sesión
  // (el primero lo hizo setDeviceNameInSystemInfo unos segundos antes).
  // Confirmado en producción: justo después de guardar Información
  // Básica, la cámara puede tardar más de lo que dan 3 intentos rápidos
  // en volver a mostrar el ícono (recarga de la pantalla, toast de
  // "Guardado" todavía en pantalla, etc.) — más intentos y más margen
  // entre cada uno para no reportar "no se encontró" antes de tiempo.
  if (!(await clickSettingsGearVerified(win, hashIncludesJs('config'), 6))) {
    throw new Error('No se encontró el ícono de "Configuración" (rueda dentada) en el panel de la cámara.');
  }
  await new Promise(r => setTimeout(r, 500));

  if (!(await clickMenuTextVerified(win, 'Imagen', `${bodyIncludesJs('Ajustes OSD')} || ${bodyIncludesJs('Máscara de privacidad')}`, 3, { excludeTabs: true }))) {
    throw new Error('No se encontró "Imagen" en el panel de la cámara.');
  }
  await new Promise(r => setTimeout(r, 500));

  // "Ajustes OSD" es una pestaña dentro del contenido de Imagen, no otro
  // ítem del sidebar — se clickea sin excludeTabs. El chequeo de
  // contenido real de abajo (onPage) confirma si realmente se llegó.
  await clickMenuText(win, ['Ajustes OSD', 'Ajuste OSD']);
  await new Promise(r => setTimeout(r, 500));

  const onPage = await waitFor(win, `
    document.body.textContent.toUpperCase().includes('OSD') ||
    document.body.textContent.toUpperCase().includes('NOMBRE DEL CANAL')
  `, 5000);
  if (!onPage) {
    const diag = await exec(win, `JSON.stringify({url: location.href, bodySnippet: document.body.textContent.slice(0,300)})`).catch(() => '{}');
    throw new Error(`No se llegó a la pantalla de Ajustes OSD (${diag}).`);
  }

  // ¿Cámara de dos canales? Buscamos elementos clickeables (no solo
  // pestañas de Element UI — esta pantalla usa botones sueltos) cuyo
  // texto sea exactamente "1"/"2"/"Canal 1"/"CH1", etc.
  //
  // Confirmado en producción: los botones de Canal pueden renderizar un
  // instante DESPUÉS de que el resto de la pantalla de Ajustes OSD ya
  // pasó el chequeo de "onPage" — una sola consulta justo en ese momento
  // podía contar solo el Canal 1 (que ya estaba en el DOM) y no
  // encontrar todavía el Canal 2, cayendo al camino de "cámara de un
  // solo canal" en una cámara que en realidad tiene dos, dejando el
  // Canal 2 sin tocar y sin ningún error visible. Se reintenta la
  // detección un par de veces dándole tiempo a terminar de renderizar
  // antes de decidir cuántos canales hay.
  const countChannelTabs = () => exec(win, `
    (function(){
      const all = Array.from(document.querySelectorAll('li, div, span, a, button, [role=tab]'));
      const chTabs = all.filter(t => /^(canal\\s*)?[12]$|^ch\\s*[12]$/i.test((t.textContent || '').trim()));
      return chTabs.length;
    })()
  `);
  let channelTabsInfo = await countChannelTabs();
  for (let attempt = 0; attempt < 4 && channelTabsInfo < 2; attempt++) {
    await new Promise(r => setTimeout(r, 400));
    channelTabsInfo = await countChannelTabs();
  }

  // Reemplaza solo "Camera" en el valor actual del campo, preservando el
  // resto (típicamente el número de canal) — si por algún motivo el
  // campo no dice "Camera", usa el número de canal detectado como
  // respaldo en vez de perder ese dato.
  //
  // No asumimos ninguna estructura de formulario particular (esta
  // pantalla no usa .el-form-item/<label>, ni siquiera input[type=text]
  // explícito) — la señal más confiable es directamente el VALOR actual
  // del campo ("Camera 01"/"Camera 02"), y solo si eso falla se busca
  // por cercanía a un texto "Nombre del canal" que no sea un botón.
  // excludePrevValue: el valor exacto que se acaba de escribir en el
  // canal anterior — si el click de la pestaña siguiente no llegó a
  // "pegar" de verdad (mismo tipo de bug ya visto con otros clicks de
  // este panel: se reporta clickeado pero el contenido no cambió), el
  // input que matchea "value contiene Camera" puede seguir sin existir
  // mientras que el campo visible sigue siendo el del canal anterior ya
  // editado — evita reescribir ese mismo campo dos veces por error.
  const setChannelName = async (fallbackSuffix, excludePrevValue) => exec(win, `
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
      function norm(s){ return (s||'').trim().toUpperCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, ''); }
      const isTextInput = el => el.tagName === 'INPUT' && (el.type === 'text' || el.type === '');
      const excludeVal = ${JSON.stringify(excludePrevValue || null)};
      const allTextInputs = Array.from(document.querySelectorAll('input')).filter(isTextInput)
        .filter(i => excludeVal === null || (i.value || '').trim() !== excludeVal);

      let input = allTextInputs.find(i => /camera/i.test(i.value || ''));

      if (!input) {
        const labelLike = Array.from(document.querySelectorAll('label, span, div'))
          .find(el => norm(el.textContent) === 'NOMBRE DEL CANAL');
        if (labelLike) {
          let container = labelLike.parentElement;
          for (let i = 0; i < 5 && container && !input; i++) {
            const found = container.querySelector('input');
            if (found && isTextInput(found) && (excludeVal === null || (found.value || '').trim() !== excludeVal)) input = found;
            container = container.parentElement;
          }
        }
      }

      if (!input) return { ok: false, newVal: null };
      const current = (input.value || '').trim();
      let newVal;
      if (/camera/i.test(current)) {
        newVal = current.replace(/camera/i, ${JSON.stringify(deviceName)});
      } else {
        const m = current.match(/(\\d+)\\s*$/);
        const suffix = m ? m[1] : ${JSON.stringify(fallbackSuffix)};
        newVal = (${JSON.stringify(deviceName)} + ' ' + suffix).trim();
      }
      const ok = setVal(input, newVal);
      return { ok, newVal: ok ? newVal : null };
    })()
  `);

  // IMPORTANTE: cada canal se guarda ANTES de cambiar de pestaña al
  // siguiente. Guardar una sola vez al final (después de setear los dos
  // canales) es lo que causaba que el cambio del Canal 1 se perdiera —
  // al clickear la pestaña "2", el formulario de Vue recarga sus datos
  // para ese canal y descarta cualquier edición sin guardar del anterior,
  // así que el único Guardar final solo terminaba aplicando el Canal 2.
  if (channelTabsInfo >= 2) {
    let prevWrittenValue = null;
    for (let ch = 1; ch <= 2; ch++) {
      let tabSwitched = false;
      for (let attempt = 0; attempt < 3 && !tabSwitched; attempt++) {
        const clicked = await exec(win, `
          (function(){
            const all = Array.from(document.querySelectorAll('li, div, span, a, button, [role=tab]'));
            const re = new RegExp('^(canal\\\\s*)?${ch}$|^ch\\\\s*${ch}$', 'i');
            let candidates = all.filter(t => re.test((t.textContent || '').trim()));
            candidates.sort((a, b) => a.innerHTML.length - b.innerHTML.length);
            const tab = candidates[0];
            if (tab) { tab.click(); return true; }
            return false;
          })()
        `);
        if (!clicked) throw new Error(`No se encontró la pestaña del canal ${ch} en Ajustes OSD.`);
        await new Promise(r => setTimeout(r, 500));
        // Los valores actuales (Camera 01/02, etc.) se cargan de forma
        // asíncrona al entrar a la pantalla o cambiar de canal. Además,
        // para canal 2+, hay que confirmar que el tab-switch realmente
        // "pegó" y no seguimos viendo el campo ya editado del canal
        // anterior — mismo tipo de click-sin-efecto ya visto en la
        // navegación del sidebar (ver clickVerified más arriba).
        // Se acota a inputs cuyo valor "tiene forma" de nombre de canal
        // (contiene "camera" o termina en un número) en vez de cualquier
        // input no vacío — la pantalla tiene otros campos (selects
        // renderizados como input, checkboxes, etc.) que podrían dar un
        // falso positivo de "ya cambió" sin que el canal haya cambiado.
        const freshCondition = prevWrittenValue
          ? `Array.from(document.querySelectorAll('input')).some(i => { const v=(i.value||'').trim(); return v !== '' && v !== ${JSON.stringify(prevWrittenValue)} && (/camera/i.test(v) || /\\d\\s*$/.test(v)); })`
          : `Array.from(document.querySelectorAll('input')).some(i => { const v=(i.value||'').trim(); return v !== '' && (/camera/i.test(v) || /\\d\\s*$/.test(v)); })`;
        tabSwitched = await waitFor(win, freshCondition, 2500, 250);
        if (!tabSwitched) await new Promise(r => setTimeout(r, 400));
      }
      if (!tabSwitched) {
        throw new Error(`No se pudo cambiar a la pestaña del canal ${ch} en Ajustes OSD (el contenido no cambió tras el click).`);
      }

      const result = await setChannelName(String(ch), prevWrittenValue);
      if (!result || !result.ok) throw new Error(`No se encontró el campo "Nombre del Canal" para el canal ${ch}.`);
      const writtenValue = result.newVal;

      await new Promise(r => setTimeout(r, 300));
      if (!(await clickSaveButton(win))) {
        throw new Error(`No se encontró un botón para guardar el canal ${ch} en Ajustes OSD.`);
      }
      // Confirma que el campo sigue mostrando el valor escrito después de
      // guardar (por si el panel recarga/revalida los datos al guardar)
      // antes de cambiar de canal — evita una carrera entre el guardado
      // y el click de la siguiente pestaña.
      await waitFor(win, `Array.from(document.querySelectorAll('input')).some(i => (i.value||'').trim() === ${JSON.stringify(writtenValue)})`, 3000, 200);
      await new Promise(r => setTimeout(r, 500));
      prevWrittenValue = writtenValue;
    }
  } else {
    await waitFor(win, `Array.from(document.querySelectorAll('input')).some(i => i.value && i.value.trim() !== '')`, 4000, 300);
    const result = await setChannelName('', null);
    if (!result || !result.ok) {
      const diag = await exec(win, `JSON.stringify(Array.from(document.querySelectorAll('input')).map(i => ({type: i.type, value: i.value})))`).catch(() => '[]');
      throw new Error(`No se encontró el campo "Nombre del Canal" en Ajustes OSD. Inputs visibles: ${diag}`);
    }

    await new Promise(r => setTimeout(r, 300));
    if (!(await clickSaveButton(win))) {
      throw new Error('No se encontró un botón para guardar en Ajustes OSD.');
    }
    await new Promise(r => setTimeout(r, 1200));
  }
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

  // Se intenta primero el camino ISAPI directo (más rápido y no depende
  // de la UI del portal) y, si algo no matchea el esquema de este
  // firmware en particular, se cae de lleno a la automatización DOM ya
  // probada — nunca se mezclan los dos mecanismos a mitad de camino.
  try {
    await tryIsapiFullFlow(win, { deviceName, targetIp, targetMask, targetGateway });
    // Igual que al cerrar el asistente DOM: si se cambió la IP, la cámara
    // puede tardar un instante en aplicar el nuevo direccionamiento antes
    // de que valga la pena cerrar la ventana.
    await new Promise(r => setTimeout(r, 1500));
    sessions.delete(accessIp);
    win.destroy();
    return { ok: true, probablySucceeded: true, via: 'isapi' };
  } catch (isapiErr) {
    console.warn(`ISAPI directo falló para ${accessIp}, se usa automatización DOM de respaldo: ${isapiErr.message}`);
  }

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
      // Margen extra antes de volver a abrir la rueda dentada — recién
      // se guardó Información Básica, y esa pantalla puede tardar un
      // instante en asentarse (toast de "Guardado", posible recarga)
      // antes de que el ícono vuelva a responder a los clicks.
      await new Promise(r => setTimeout(r, 800));
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

    // Mismo problema que se confirmó con el camino ISAPI: el asistente
    // puede reportar "listo" (encontró y clickeó un botón final) sin que
    // la cámara realmente haya aplicado la IP nueva. Se relee vía ISAPI
    // (autenticado por la misma cookie de sesión) antes de dar por bueno
    // el cambio.
    await verifyNetworkApplied(win, '/ISAPI/System/Network/interfaces/1/ipAddress', targetIp);

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
