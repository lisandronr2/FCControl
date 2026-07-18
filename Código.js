/**
 * FCControl — Backend Google Apps Script
 * Archivo: CAMARAS (Google Sheets en Drive)
 * ─────────────────────────────────────────
 * Lee las columnas dinámicamente desde la fila 1.
 * Solo requiere que existan:
 *   • Una columna cuyo encabezado contenga "NOMBRE"
 *   • Una columna cuyo encabezado contenga "SERIAL"
 *
 * Endpoints GET:
 *   ?action=schema          → encabezados + índices de NOMBRE y SERIAL
 *   ?action=list            → NOMBRE (+ CT y UBICACION si existen) de cada fila
 *   ?action=get&nombre=XXX  → fila completa del dispositivo XXX
 *
 * Endpoint POST (JSON body):
 *   { nombre, serial, tecnico?, estado?, rowIndex } → actualiza SERIAL
 *   (y ESTADO/FECHA/TECNICO si esas columnas existen en la hoja)
 *
 * La columna ESTADO se detecta automáticamente (encabezado que contenga
 * "ESTADO" o sea "STATUS"). Las opciones que el usuario puede elegir en la
 * app se toman de la validación de datos (desplegable) que ya tengas puesta
 * en esa columna del Sheet; si no hay validación, se usan los valores que
 * ya existan en la columna.
 */

const SHEET_NAME = 'CAMARAS'; // Nombre exacto de la pestaña en tu Google Sheet

// ── Utilidades ────────────────────────────────────────────────
function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // Intenta con el nombre exacto primero
  let sheet = ss.getSheetByName(SHEET_NAME);
  // Si no existe, usa la primera hoja
  if (!sheet) sheet = ss.getSheets()[0];
  return sheet;
}

function getSchema(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  let nombreCol = -1, serialCol = -1, estadoCol = -1, ctCol = -1, ubicacionCol = -1;
  headers.forEach((h, i) => {
    const upper = String(h).toUpperCase().trim();
    if (upper.includes('NOMBRE') && nombreCol === -1) nombreCol = i;
    if (upper.includes('SERIAL') && serialCol === -1) serialCol = i;
    if ((upper.includes('ESTADO') || upper === 'STATUS') && estadoCol === -1) estadoCol = i;
    if (/\bCT\b/.test(upper) && ctCol === -1) ctCol = i;
    if ((upper.includes('UBICACION') || upper.includes('UBICACIÓN') || upper === 'LOCATION') && ubicacionCol === -1) ubicacionCol = i;
  });
  return { headers, nombreCol, serialCol, estadoCol, ctCol, ubicacionCol };
}

// Lee las opciones válidas de la columna ESTADO: primero intenta tomar la
// lista de la validación de datos (menú desplegable) que ya tengas configurada
// en el Sheet; si no hay validación, usa los valores únicos ya presentes en
// la columna como opciones de respaldo.
function getEstadoOptions(sheet, estadoCol) {
  if (estadoCol === -1) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const range = sheet.getRange(2, estadoCol + 1, lastRow - 1, 1);
  const validations = range.getDataValidations();

  for (let i = 0; i < validations.length; i++) {
    const rule = validations[i][0];
    if (!rule) continue;
    const criteria = rule.getCriteriaType();
    if (criteria === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
      return rule.getCriteriaValues()[0];
    }
    if (criteria === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE) {
      const listRange = rule.getCriteriaValues()[0];
      return listRange.getValues().flat().map(String).map(v => v.trim()).filter(v => v);
    }
  }

  // Respaldo: valores únicos ya usados en la columna
  const values = range.getValues().flat().map(v => String(v).trim()).filter(v => v);
  return [...new Set(values)];
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── GET ───────────────────────────────────────────────────────
function doGet(e) {
  const action = (e.parameter.action || '').toLowerCase();

  if (action === 'schema') return respond(handleSchema());
  if (action === 'list')   return respond(handleList());
  if (action === 'get')    return respond(handleGet(e.parameter.nombre || ''));
  if (action === 'all')    return respond(handleAll());

  return respond({ error: 'Acción no reconocida. Usa: schema, list, get o all.' });
}

function handleSchema() {
  const sheet = getSheet();
  const { headers, nombreCol, serialCol } = getSchema(sheet);
  if (nombreCol === -1) return { error: 'No se encontró una columna NOMBRE en la hoja.' };
  if (serialCol === -1) return { error: 'No se encontró una columna SERIAL en la hoja.' };
  return {
    ok: true,
    sheetName: sheet.getName(),
    headers: headers.map(h => String(h).trim()),
    nombreCol,
    serialCol,
    totalRows: sheet.getLastRow() - 1
  };
}

function handleList() {
  const sheet = getSheet();
  const { nombreCol, ctCol, ubicacionCol } = getSchema(sheet);
  if (nombreCol === -1) return { error: 'No se encontró columna NOMBRE.' };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { names: [] };

  const lastCol = sheet.getLastColumn();
  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const names = values
    .map((r, i) => ({
      name:      String(r[nombreCol]).trim(),
      ct:        ctCol       !== -1 ? String(r[ctCol]).trim()        : '',
      ubicacion: ubicacionCol !== -1 ? String(r[ubicacionCol]).trim() : '',
      row: i + 2
    }))
    .filter(e => e.name);
  return { names };
}

function handleGet(nombre) {
  if (!nombre) return { error: 'Falta el parámetro nombre.' };

  const sheet = getSheet();
  const { headers, nombreCol, estadoCol } = getSchema(sheet);
  if (nombreCol === -1) return { error: 'No se encontró columna NOMBRE.' };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { result: null };

  const allRows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const q = nombre.trim().toLowerCase();

  // Coincidencia exacta primero, luego parcial
  let match = allRows.find(r => String(r[nombreCol]).trim().toLowerCase() === q);
  if (!match) match = allRows.find(r => String(r[nombreCol]).trim().toLowerCase().includes(q));

  if (!match) return { result: null };

  // Construye objeto dinámico con todos los campos
  const row = {};
  headers.forEach((h, i) => {
    const key = String(h).trim();
    if (key) row[key] = match[i] !== undefined && match[i] !== '' ? String(match[i]) : '';
  });

  // Busca el número de fila real para poder actualizar después
  const rowIndex = allRows.indexOf(match) + 2;

  const estadoOptions = estadoCol !== -1 ? getEstadoOptions(sheet, estadoCol) : [];

  return {
    result: row,
    rowIndex,
    headers: headers.map(h => String(h).trim()),
    estadoOptions
  };
}

// Devuelve todos los dispositivos en un solo request para caché offline
function handleAll() {
  const sheet = getSheet();
  const { headers, nombreCol, estadoCol } = getSchema(sheet);
  if (nombreCol === -1) return { error: 'No se encontró columna NOMBRE.' };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, devices: {}, headers: [], estadoOptions: [] };

  const cleanHeaders = headers.map(h => String(h).trim());
  const allRows      = sheet.getRange(2, 1, lastRow - 1, cleanHeaders.length).getValues();
  const estadoOptions = estadoCol !== -1 ? getEstadoOptions(sheet, estadoCol) : [];

  const devices = {};
  allRows.forEach((row, i) => {
    const nombre = String(row[nombreCol]).trim();
    if (!nombre) return;
    const record = {};
    cleanHeaders.forEach((h, j) => {
      if (h) record[h] = (row[j] !== undefined && row[j] !== '') ? String(row[j]) : '';
    });
    devices[nombre.toLowerCase()] = { result: record, rowIndex: i + 2 };
  });

  return { ok: true, devices, headers: cleanHeaders, estadoOptions };
}

// ── POST ──────────────────────────────────────────────────────
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    return respond(handleSave(data));
  } catch (err) {
    return respond({ error: 'Error al procesar la solicitud: ' + err.message });
  }
}

function handleSave(data) {
  if (!data.nombre || !data.nombre.trim()) throw new Error('Falta el nombre del dispositivo.');
  if (!data.serial  || !data.serial.trim())  throw new Error('El Serial Number es obligatorio.');

  const sheet = getSheet();
  const { headers, nombreCol, serialCol, estadoCol } = getSchema(sheet);
  if (nombreCol === -1) throw new Error('No se encontró columna NOMBRE en la hoja.');
  if (serialCol === -1) throw new Error('No se encontró columna SERIAL en la hoja.');

  // Encontrar la fila (usa rowIndex si lo manda el cliente, o búsqueda fresca)
  let rowIndex = data.rowIndex;
  if (!rowIndex) {
    const lastRow = sheet.getLastRow();
    const values  = sheet.getRange(2, nombreCol + 1, lastRow - 1, 1).getValues();
    const idx = values.findIndex(r =>
      String(r[0]).trim().toLowerCase() === data.nombre.trim().toLowerCase()
    );
    if (idx === -1) throw new Error('Dispositivo "' + data.nombre + '" no encontrado.');
    rowIndex = idx + 2;
  }

  // Actualizar solo la columna SERIAL
  sheet.getRange(rowIndex, serialCol + 1).setValue(data.serial.trim());

  // Actualizar ESTADO si la hoja tiene esa columna y el cliente mandó un valor
  if (estadoCol !== -1 && data.estado && data.estado.trim()) {
    sheet.getRange(rowIndex, estadoCol + 1).setValue(data.estado.trim());
  }

  // Opcional: si hay columna FECHA o TECNICO, actualizarlas también
  const tz    = Session.getScriptTimeZone() || 'America/Mexico_City';
  const stamp = Utilities.formatDate(new Date(), tz, 'dd/MM/yyyy HH:mm');

  headers.forEach((h, i) => {
    const upper = String(h).toUpperCase().trim();
    if (upper.includes('FECHA') || upper === 'DATE' || upper === 'UPDATED') {
      sheet.getRange(rowIndex, i + 1).setValue(stamp);
    }
    if ((upper.includes('TECNICO') || upper.includes('TÉCNICO') || upper === 'VERIFIED BY') && data.tecnico) {
      sheet.getRange(rowIndex, i + 1).setValue(data.tecnico.trim());
    }
    if (upper.includes('MAC') && data.mac && data.mac.trim()) {
      sheet.getRange(rowIndex, i + 1).setValue(data.mac.trim());
    }
  });

  return {
    ok: true,
    nombre: data.nombre,
    serial: data.serial,
    estado: (estadoCol !== -1 && data.estado) ? data.estado.trim() : '',
    mac: data.mac ? data.mac.trim() : '',
    fecha: stamp,
    rowIndex
  };
}

