// Cliente ISAPI para cámaras Hikvision/HikMicro — corre en el proceso
// principal de Electron (Node puro), sin las restricciones de un
// navegador: acá no hay contenido mixto ni CORS, así que hablar HTTP/HTTPS
// con la cámara es directo. Es el equivalente de escritorio del plugin
// nativo de Android (HikvisionCameraPlugin.kt / HikvisionIsapiClient.kt /
// DigestAuth.kt) — misma lógica, mismo flujo de activación/login, mismo
// manejo del "corte esperado" al cambiar de IP.

const http = require('http');
const https = require('https');
const crypto = require('crypto');

function md5(input) {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex');
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function parseDigestChallenge(header) {
  if (!header || !/^Digest/i.test(header.trim())) return null;
  const params = {};
  const re = /(\w+)="?([^",]+)"?/g;
  let m;
  while ((m = re.exec(header)) !== null) params[m[1]] = m[2];
  if (!params.realm || !params.nonce) return null;
  return { realm: params.realm, nonce: params.nonce, qop: params.qop, opaque: params.opaque };
}

function buildAuthorizationHeader(challenge, method, uri, username, password, nc = '00000001') {
  const cnonce = randomHex(16);
  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = challenge.qop && challenge.qop.split(',').map(s => s.trim()).find(s => s === 'auth');
  const response = qop
    ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);

  let header = `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", response="${response}"`;
  if (qop) header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (challenge.opaque) header += `, opaque="${challenge.opaque}"`;
  return header;
}

function xmlTagValue(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1].trim() : null;
}

// Arma un detalle legible de un error ISAPI: la cámara casi siempre
// devuelve algo como "Invalid Operation" sin más contexto, así que acá
// sumamos el código HTTP y el subStatusCode (mucho más específico) si
// la respuesta lo trae, para no quedarnos con un mensaje genérico.
function describeIsapiError(resp) {
  const statusString = xmlTagValue(resp.body, 'statusString');
  const subStatusCode = xmlTagValue(resp.body, 'subStatusCode');
  const parts = [];
  parts.push(statusString || `HTTP ${resp.code}`);
  if (subStatusCode) parts.push(`detalle: ${subStatusCode}`);
  parts.push(`http=${resp.code}`);
  return parts.join(' · ');
}

function rawRequest(protocol, hostname, port, method, path, headers, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const lib = protocol === 'https:' ? https : http;
    const options = {
      hostname, port, path, method,
      headers: {
        Accept: 'application/xml',
        ...(body ? { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers
      },
      timeout: timeoutMs
    };
    if (protocol === 'https:') options.rejectUnauthorized = false; // certificado autofirmado propio de la cámara

    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve({ code: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Sondeo liviano para decidir si la cámara habla HTTPS (443, certificado
// autofirmado) o HTTP (80) plano. Varios firmwares Hikvision/HikMicro
// recientes exigen HTTPS específicamente para /ISAPI/Security/activate y
// devuelven un rechazo genérico ("Invalid Operation") si se los llama por
// HTTP — de ahí que convenga fijar el protocolo una sola vez por sesión.
async function detectProtocol(accessIp, timeoutMs = 4000) {
  try {
    await rawRequest('https:', accessIp, 443, 'GET', '/ISAPI/System/deviceInfo', {}, null, timeoutMs);
    return 'https:';
  } catch (e) {
    return 'http:';
  }
}

async function requestNoAuth(protocol, accessIp, method, path, body) {
  const port = protocol === 'https:' ? 443 : 80;
  return rawRequest(protocol, accessIp, port, method, path, {}, body);
}

async function requestAuth(protocol, accessIp, method, path, user, pass, body) {
  const port = protocol === 'https:' ? 443 : 80;
  const probe = await rawRequest(protocol, accessIp, port, method, path, {}, body);
  if (probe.code !== 401) return probe;

  const wwwAuth = probe.headers['www-authenticate'];
  const challenge = parseDigestChallenge(wwwAuth);
  if (!challenge) return probe;

  const authHeader = buildAuthorizationHeader(challenge, method, path, user, pass);
  return rawRequest(protocol, accessIp, port, method, path, { Authorization: authHeader }, body);
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Sesiones en memoria del proceso, keyed por accessIp (se pierden al cerrar la app)
const sessions = new Map();

async function readAndSecure({ accessIp, currentUser = 'admin', currentPass = '12345', newPass }) {
  if (!accessIp) throw new Error('Falta accessIp');
  if (!newPass) throw new Error('Falta newPass');

  const protocol = await detectProtocol(accessIp);
  console.log(`[hikvision] ${accessIp}: usando ${protocol}`);

  const activateBody = `<?xml version="1.0" encoding="UTF-8"?>
<ActivationInfo xmlns="http://www.hikvision.com/ver20/XMLSchema">
<Password>${escapeXml(newPass)}</Password>
</ActivationInfo>`;
  const activateResp = await requestNoAuth(protocol, accessIp, 'POST', '/ISAPI/Security/activate', activateBody);
  console.log('[hikvision] activate:', activateResp.code, activateResp.body);

  let effectiveUser = 'admin';
  let effectivePass;
  let activated;

  if (activateResp.code >= 200 && activateResp.code < 300) {
    activated = true;
    effectivePass = newPass;
  } else {
    activated = false;
    const activateDetail = describeIsapiError(activateResp);
    const userBody = `<?xml version="1.0" encoding="UTF-8"?>
<User xmlns="http://www.hikvision.com/ver20/XMLSchema">
<id>1</id>
<userName>${currentUser}</userName>
<password>${escapeXml(newPass)}</password>
</User>`;
    const pwResp = await requestAuth(protocol, accessIp, 'PUT', '/ISAPI/Security/users/1', currentUser, currentPass, userBody);
    console.log('[hikvision] change-password:', pwResp.code, pwResp.body);
    if (pwResp.code < 200 || pwResp.code >= 300) {
      throw new Error(
        `Cambio de contraseña rechazado (${describeIsapiError(pwResp)}). ` +
        `[La activación de fábrica también falló antes: ${activateDetail}]`
      );
    }
    effectivePass = newPass;
  }

  const netResp = await requestAuth(protocol, accessIp, 'GET', '/ISAPI/System/Network/interfaces', effectiveUser, effectivePass);
  if (netResp.code < 200 || netResp.code >= 300) {
    throw new Error(`No se pudo leer la configuración de red (${describeIsapiError(netResp)}).`);
  }

  const mac = xmlTagValue(netResp.body, 'MACAddress') || '';
  const currentIp = xmlTagValue(netResp.body, 'ipAddress') || '';
  const currentMask = xmlTagValue(netResp.body, 'subnetMask') || '';
  const interfaceId = xmlTagValue(netResp.body, 'id') || '1';

  sessions.set(accessIp, { protocol, user: effectiveUser, pass: effectivePass, interfaceId });

  return { ok: true, activated, mac, currentIp, currentMask, interfaceId };
}

async function applyNetwork({ accessIp, targetIp, targetMask, targetGateway }) {
  const session = sessions.get(accessIp);
  if (!session) throw new Error('Primero ejecutá el paso de credenciales (readAndSecure) para esta cámara.');
  if (!targetIp) throw new Error('Falta targetIp');
  if (!targetMask) throw new Error('Falta targetMask');

  const gwXml = targetGateway
    ? `<DefaultGateway><ipAddress>${escapeXml(targetGateway)}</ipAddress></DefaultGateway>` : '';

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<NetworkInterface xmlns="http://www.hikvision.com/ver20/XMLSchema">
<id>${session.interfaceId}</id>
<IPAddress>
<ipVersion>v4</ipVersion>
<addressingType>static</addressingType>
<ipAddress>${escapeXml(targetIp)}</ipAddress>
<subnetMask>${escapeXml(targetMask)}</subnetMask>
${gwXml}
</IPAddress>
</NetworkInterface>`;

  const path = `/ISAPI/System/Network/interfaces/${session.interfaceId}`;
  try {
    const resp = await requestAuth(session.protocol, accessIp, 'PUT', path, session.user, session.pass, body);
    sessions.delete(accessIp); // la IP cambió: la sesión ya no es válida a esta dirección

    if (resp.code >= 200 && resp.code < 300) {
      return { ok: true, probablySucceeded: false };
    }
    return { ok: false, message: `No se pudo aplicar la red (${describeIsapiError(resp)}).` };
  } catch (e) {
    // Esperado: la cámara cambia de IP a mitad de la respuesta y corta la conexión.
    sessions.delete(accessIp);
    if (String(e.message).includes('timeout') || e.code === 'ECONNRESET') {
      return { ok: true, probablySucceeded: true };
    }
    throw e;
  }
}

module.exports = { readAndSecure, applyNetwork };
