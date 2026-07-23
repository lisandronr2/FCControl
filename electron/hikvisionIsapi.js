// Cliente ISAPI para cámaras Hikvision — corre en el proceso principal de
// Electron (Node puro), sin las restricciones de un navegador: acá no hay
// contenido mixto ni CORS, así que hablar HTTP plano con la cámara es
// directo. Es el equivalente de escritorio del plugin nativo de Android
// (HikvisionCameraPlugin.kt / HikvisionIsapiClient.kt / DigestAuth.kt) —
// misma lógica, mismo flujo de activación/login, mismo manejo del
// "corte esperado" al cambiar de IP.

const http = require('http');
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

function rawRequest(baseUrl, method, path, headers, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method,
        headers: {
          Accept: 'application/xml',
          ...(body ? { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) } : {}),
          ...headers
        },
        timeout: timeoutMs
      },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => resolve({ code: res.statusCode, body: data, headers: res.headers }));
      }
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function requestNoAuth(baseUrl, method, path, body) {
  return rawRequest(baseUrl, method, path, {}, body);
}

async function requestAuth(baseUrl, method, path, user, pass, body) {
  const probe = await rawRequest(baseUrl, method, path, {}, body);
  if (probe.code !== 401) return probe;

  const wwwAuth = probe.headers['www-authenticate'];
  const challenge = parseDigestChallenge(wwwAuth);
  if (!challenge) return probe;

  const authHeader = buildAuthorizationHeader(challenge, method, path, user, pass);
  return rawRequest(baseUrl, method, path, { Authorization: authHeader }, body);
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

  const baseUrl = `http://${accessIp}`;

  const activateBody = `<?xml version="1.0" encoding="UTF-8"?>
<ActivationInfo xmlns="http://www.hikvision.com/ver20/XMLSchema">
<Password>${escapeXml(newPass)}</Password>
</ActivationInfo>`;
  const activateResp = await requestNoAuth(baseUrl, 'POST', '/ISAPI/Security/activate', activateBody);

  let effectiveUser = 'admin';
  let effectivePass;
  let activated;

  if (activateResp.code >= 200 && activateResp.code < 300) {
    activated = true;
    effectivePass = newPass;
  } else {
    activated = false;
    const userBody = `<?xml version="1.0" encoding="UTF-8"?>
<User xmlns="http://www.hikvision.com/ver20/XMLSchema">
<id>1</id>
<userName>${currentUser}</userName>
<password>${escapeXml(newPass)}</password>
</User>`;
    const pwResp = await requestAuth(baseUrl, 'PUT', '/ISAPI/Security/users/1', currentUser, currentPass, userBody);
    if (pwResp.code < 200 || pwResp.code >= 300) {
      const msg = xmlTagValue(pwResp.body, 'statusString') || `La cámara rechazó las credenciales actuales (código ${pwResp.code}).`;
      throw new Error(msg);
    }
    effectivePass = newPass;
  }

  const netResp = await requestAuth(baseUrl, 'GET', '/ISAPI/System/Network/interfaces', effectiveUser, effectivePass);
  if (netResp.code < 200 || netResp.code >= 300) {
    throw new Error(`No se pudo leer la configuración de red (código ${netResp.code}).`);
  }

  const mac = xmlTagValue(netResp.body, 'MACAddress') || '';
  const currentIp = xmlTagValue(netResp.body, 'ipAddress') || '';
  const currentMask = xmlTagValue(netResp.body, 'subnetMask') || '';
  const interfaceId = xmlTagValue(netResp.body, 'id') || '1';

  sessions.set(accessIp, { baseUrl, user: effectiveUser, pass: effectivePass, interfaceId });

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
    const resp = await requestAuth(session.baseUrl, 'PUT', path, session.user, session.pass, body);
    sessions.delete(accessIp); // la IP cambió: la sesión ya no es válida a esta dirección

    if (resp.code >= 200 && resp.code < 300) {
      return { ok: true, probablySucceeded: false };
    }
    return { ok: false, message: xmlTagValue(resp.body, 'statusString') || `La cámara devolvió un error (código ${resp.code}).` };
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
