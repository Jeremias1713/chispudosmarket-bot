// Carga agencies.csv y encuentra la agencia mas cercana a una ubicacion dada,
// o busca por texto (estado/region/nombre/direccion) cuando no hay coordenadas.
// El listado se puede reemplazar en caliente subiendo un Excel desde el panel
// (Configuracion > Cobertura de agencias): ver importFromWorkbookBuffer.
const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, '..', 'data', 'agencies.csv');
const CSV_HEADERS = ['name', 'country', 'region', 'address', 'phone', 'lat', 'lon'];

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).filter(Boolean).map((line) => {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h.trim()] = (values[i] || '').trim();
    });
    return row;
  });
}

// Manejo simple de CSV con comillas para campos que contienen comas (ej. direcciones).
function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

// Arma una linea de CSV, entre comillas solo los campos que lo necesitan
// (tienen coma, comilla o salto de linea), como hace cualquier Excel.
function csvField(value) {
  const s = String(value == null ? '' : value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCsv(rows) {
  const lines = [CSV_HEADERS.join(',')];
  for (const r of rows) {
    lines.push(CSV_HEADERS.map((h) => csvField(r[h])).join(','));
  }
  fs.writeFileSync(CSV_PATH, lines.join('\n') + '\n');
}

function loadAgencies() {
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  return parseCsv(text)
    .map((row) => ({
      ...row,
      lat: parseFloat(row.lat),
      lon: parseFloat(row.lon),
    }))
    .filter((row) => row.name);
}

// Info corta para mostrar en el panel: cuantas agencias hay cargadas y en
// cuantas regiones/estados, sin mandar el listado completo.
function getMeta() {
  let agencies = [];
  try {
    agencies = loadAgencies();
  } catch (err) {
    agencies = [];
  }
  const regions = new Set(agencies.map((a) => a.region).filter(Boolean));
  let updatedAt = null;
  try {
    updatedAt = fs.statSync(CSV_PATH).mtime.toISOString();
  } catch (err) {
    updatedAt = null;
  }
  return { count: agencies.length, regions: regions.size, updatedAt };
}

// Formula haversine: distancia en km entre dos puntos lat/lon.
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371; // radio de la Tierra en km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Devuelve las N agencias mas cercanas a una coordenada dada. Si el listado
// actual no tiene coordenadas cargadas (ej. import desde Excel sin lat/lon),
// devuelve vacio: flow.js ya sabe pedirle la ciudad como alternativa.
function nearestByCoords(lat, lon, limit = 3) {
  const agencies = loadAgencies().filter(
    (a) => !Number.isNaN(a.lat) && !Number.isNaN(a.lon)
  );
  return agencies
    .map((a) => ({ ...a, distanceKm: haversineKm(lat, lon, a.lat, a.lon) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

// Busqueda por texto libre (ciudad, estado, sector o pais) cuando el usuario
// escribe en vez de compartir ubicacion. Tambien mira dentro de la direccion
// completa porque ahi suelen aparecer el municipio/parroquia/ciudad exacta
// (ej. "Maracaibo", "Baruta", "Chacao") aunque no sean el nombre de la agencia.
// Saca tildes/acentos para que "tachira" matchee "TÁCHIRA" y "san cristobal"
// matchee "SAN CRISTÓBAL": la gente en Venezuela escribe sin tildes seguido.
function foldAccents(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function searchByText(query, limit = 5) {
  const q = foldAccents(query.trim());
  if (!q) return [];
  const agencies = loadAgencies();
  // OJO: antes esto tambien comparaba contra a.country. Pero "country" es
  // siempre "Venezuela" en TODAS las filas (no es un dato que distinga nada
  // entre agencias), asi que si alguna vez la IA le pasaba a esta busqueda
  // el texto "Venezuela" en vez de un estado puntual (una confusion real que
  // paso: le pidieron la agencia de Maturin, Monagas, y la IA busco con
  // estado="Venezuela"), matcheaba TODAS las agencias del pais de una y
  // mandaba un listado gigante de agencias de cualquier lado menos de donde
  // preguntaba el cliente. Sacamos country de la comparacion: nunca aporta
  // precision, solo puede causar este falso positivo masivo.
  const nameMatches = agencies.filter(
    (a) =>
      foldAccents(a.name).includes(q) ||
      foldAccents(a.region).includes(q) ||
      foldAccents(a.city).includes(q)
  );
  if (nameMatches.length) return nameMatches.slice(0, limit);

  // Si no matcheo por nombre/region, probamos dentro de la direccion.
  return agencies.filter((a) => foldAccents(a.address).includes(q)).slice(0, limit);
}

// Diccionario chico (no exhaustivo, pero cubre las capitales de estado y las
// ciudades/pueblos mas conocidos que NO comparten nombre con su estado) para
// no depender de que la IA "deduzca" el estado de una ciudad por su cuenta.
// Eso fallo en la practica mas de una vez: le pidieron la agencia de
// Maturin (Monagas) y la IA busco con estado="Venezuela"; despues le
// pidieron la de Guasdalito (Apure) y la IA busco en el estado Merida. Sin
// una lista real de memoria, gpt-4o-mini a veces confunde o inventa el
// estado de un pueblo que no es tan conocido. Cuando la ciudad que menciona
// el cliente esta aca, se usa este estado, IGNORANDO lo que haya mandado la
// IA: es un dato duro. Si la ciudad no esta en la lista, se sigue confiando
// en el estado que dedujo la IA (con la salvedad ya avisada en el prompt de
// pedirle que confirme si no la reconoce con confianza).
const CITY_TO_STATE = {
  'puerto ayacucho': 'Amazonas',
  barcelona: 'Anzoategui',
  'puerto la cruz': 'Anzoategui',
  lecheria: 'Anzoategui',
  guanta: 'Anzoategui',
  'el tigre': 'Anzoategui',
  anaco: 'Anzoategui',
  'san fernando de apure': 'Apure',
  guasdalito: 'Apure',
  achaguas: 'Apure',
  maracay: 'Aragua',
  'la victoria': 'Aragua',
  turmero: 'Aragua',
  cagua: 'Aragua',
  'el limon': 'Aragua',
  'san mateo': 'Aragua',
  'ciudad bolivar': 'Bolivar',
  'ciudad guayana': 'Bolivar',
  'puerto ordaz': 'Bolivar',
  upata: 'Bolivar',
  guasipati: 'Bolivar',
  'el callao': 'Bolivar',
  'santa elena de uairen': 'Bolivar',
  valencia: 'Carabobo',
  'puerto cabello': 'Carabobo',
  guacara: 'Carabobo',
  naguanagua: 'Carabobo',
  'san diego': 'Carabobo',
  'san carlos': 'Cojedes',
  tinaquillo: 'Cojedes',
  tucupita: 'Delta Amacuro',
  caracas: 'Distrito Capital',
  // Parroquias y zonas/urbanizaciones de Caracas de uso muy comun, agregadas
  // por el mismo motivo que ya paso con Catia/El Junquito: un cliente nombra
  // una de estas en vez de decir literalmente "Caracas", el modelo a veces
  // le adivina mal el estado (esto paso de verdad con "Antimano", que
  // termino buscado en Miranda en vez de Distrito Capital), y como estas SI
  // estan en el diccionario, el codigo (ver runTool en ai.js) ignora el
  // estado que haya dicho el modelo y usa el real.
  // OJO: esto NO sigue estrictamente la division politica de Venezuela (el
  // area metropolitana de Caracas en realidad se reparte entre el Distrito
  // Capital y varios municipios del estado Miranda — Chacao, Baruta, Sucre,
  // El Hatillo). Lo que importa aca es como el NEGOCIO agrupa sus propias
  // agencias: las agencias reales que carga (ver el Excel del panel) meten
  // TODAS estas zonas juntas bajo un mismo bloque "Caracas" (asi salieron
  // agrupadas Boleita, Catia, El Cafetal, Chacao, Filas de Mariches, Los
  // Palos Grandes, etc. cuando un cliente pregunto por Caracas), asi que
  // "Distrito Capital" aca funciona como el nombre de ESE bloque, no como la
  // division administrativa real. Si el negocio llega a separar sus agencias
  // por municipio en vez de agruparlas todas como "Caracas", esta lista
  // dejaria de ser correcta y habria que revisarla.
  'la candelaria': 'Distrito Capital',
  candelaria: 'Distrito Capital',
  antimano: 'Distrito Capital',
  catia: 'Distrito Capital',
  'el paraiso': 'Distrito Capital',
  'el valle': 'Distrito Capital',
  'el recreo': 'Distrito Capital',
  'la vega': 'Distrito Capital',
  'la pastora': 'Distrito Capital',
  macarao: 'Distrito Capital',
  caricuao: 'Distrito Capital',
  coche: 'Distrito Capital',
  'san agustin': 'Distrito Capital',
  'san bernardino': 'Distrito Capital',
  'san jose': 'Distrito Capital',
  'san juan': 'Distrito Capital',
  'san pedro': 'Distrito Capital',
  'santa rosalia': 'Distrito Capital',
  'santa teresa': 'Distrito Capital',
  altagracia: 'Distrito Capital',
  '23 de enero': 'Distrito Capital',
  'el junquito': 'Distrito Capital',
  junquito: 'Distrito Capital',
  chacao: 'Distrito Capital',
  boleita: 'Distrito Capital',
  'el cafetal': 'Distrito Capital',
  'el cementerio': 'Distrito Capital',
  'el rosal': 'Distrito Capital',
  'los caobos': 'Distrito Capital',
  'los chaguaramos': 'Distrito Capital',
  'los palos grandes': 'Distrito Capital',
  montecristo: 'Distrito Capital',
  'prados del este': 'Distrito Capital',
  'sabana grande': 'Distrito Capital',
  'san martin': 'Distrito Capital',
  california: 'Distrito Capital',
  'filas de mariches': 'Distrito Capital',
  coro: 'Falcon',
  'punto fijo': 'Falcon',
  judibana: 'Falcon',
  'santa ana de coro': 'Falcon',
  'san juan de los morros': 'Guarico',
  calabozo: 'Guarico',
  'valle de la pascua': 'Guarico',
  zaraza: 'Guarico',
  barquisimeto: 'Lara',
  carora: 'Lara',
  quibor: 'Lara',
  'el tocuyo': 'Lara',
  cabudare: 'Lara',
  ejido: 'Merida',
  'el vigia': 'Merida',
  tovar: 'Merida',
  'los teques': 'Miranda',
  guarenas: 'Miranda',
  guatire: 'Miranda',
  charallave: 'Miranda',
  'ocumare del tuy': 'Miranda',
  higuerote: 'Miranda',
  maturin: 'Monagas',
  'punta de mata': 'Monagas',
  caripito: 'Monagas',
  'la asuncion': 'Nueva Esparta',
  porlamar: 'Nueva Esparta',
  pampatar: 'Nueva Esparta',
  juangriego: 'Nueva Esparta',
  guanare: 'Portuguesa',
  acarigua: 'Portuguesa',
  araure: 'Portuguesa',
  guanarito: 'Portuguesa',
  cumana: 'Sucre',
  carupano: 'Sucre',
  guiria: 'Sucre',
  'san cristobal': 'Tachira',
  tariba: 'Tachira',
  rubio: 'Tachira',
  'la fria': 'Tachira',
  'la grita': 'Tachira',
  valera: 'Trujillo',
  bocono: 'Trujillo',
  'la guaira': 'La Guaira',
  'catia la mar': 'La Guaira',
  maiquetia: 'La Guaira',
  'san felipe': 'Yaracuy',
  chivacoa: 'Yaracuy',
  yaritagua: 'Yaracuy',
  maracaibo: 'Zulia',
  cabimas: 'Zulia',
  'ciudad ojeda': 'Zulia',
  'santa barbara': 'Zulia',
  machiques: 'Zulia',
};

// Busca cual de las ciudades conocidas del diccionario de arriba aparece
// dentro del texto que mando el modelo. Antes esto exigia una IGUALDAD
// exacta (foldAccents(ciudad) === la clave del diccionario), lo que fallaba
// en un caso real: el cliente escribio "San Carlos Cojedes Venezuela" y el
// modelo paso ese texto completo (o parte de el) como "ciudad" en vez de
// solo "San Carlos", asi que la clave exacta "san carlos" nunca matcheaba,
// el diccionario no encontraba nada, y el bot terminaba confiando en el
// estado que el modelo habia adivinado (que en ese caso fue "Distrito
// Capital", mandandole a un cliente de Cojedes las agencias de Caracas). Con
// una busqueda por substring esto ya no depende de que el modelo mande el
// nombre de la ciudad pelado: si "san carlos" aparece en cualquier parte del
// texto, se lo reconoce igual. Si varias ciudades conocidas aparecen a la
// vez, se prioriza la mas larga (mas especifica).
function findKnownCityKey(ciudad) {
  const key = foldAccents(String(ciudad || '')).trim();
  if (!key) return null;
  if (CITY_TO_STATE[key]) return key;
  const candidates = Object.keys(CITY_TO_STATE)
    .filter((city) => key.includes(city))
    .sort((a, b) => b.length - a.length);
  return candidates[0] || null;
}

// Devuelve el estado real de una ciudad conocida (o null si no esta en el
// diccionario de arriba, en cuyo caso el llamador sigue usando el estado que
// haya deducido la IA).
function resolveStateForCity(ciudad) {
  const key = findKnownCityKey(ciudad);
  return key ? CITY_TO_STATE[key] : null;
}

// Cierto de verdad: "caracas" es la UNICA ciudad de este diccionario que
// mapea a "Distrito Capital". Esto importa porque las agencias reales que
// carga el negocio (via el Excel del panel) a veces estan nombradas por
// barrio ("Catia", "El Junquito") en vez de decir literalmente "Caracas" en
// el nombre o la direccion: buscar el texto "caracas" en esos casos deja
// afuera a la mayoria de las agencias de Distrito Capital, aunque SI esten
// cargadas. Como "caracas" es la unica ciudad de ese estado en el
// diccionario, buscar por el estado completo (Distrito Capital) es
// exactamente lo mismo que buscar por la ciudad: no hay riesgo de mezclar
// agencias de otro pueblo lejano bajo el nombre de Caracas. Para estados con
// mas de una ciudad conocida (ej. Zulia: Maracaibo, Cabimas, Ciudad Ojeda...)
// esto da false, asi que ahi se sigue confiando solo en el match puntual por
// nombre de ciudad.
function isSoleCityOfItsState(ciudad) {
  const key = findKnownCityKey(ciudad);
  if (!key) return false;
  const estado = CITY_TO_STATE[key];
  // Distrito Capital es un caso especial: ahora el diccionario tiene MUCHAS
  // entradas para ahi a proposito (Antimano, Catia, Chacao, etc. — ver el
  // comentario donde se cargan), todas dentro del mismo bloque "Caracas" que
  // usa el negocio. A diferencia de un estado real con varias ciudades
  // DISTINTAS (ej. Zulia: Maracaibo, Cabimas...), ampliar de una zona
  // puntual de Caracas a todo el bloque "Distrito Capital" sigue siendo
  // seguro (es el mismo bloque, no se mezclan pueblos de otro lado), asi que
  // esto siempre da true para Distrito Capital sin importar cuantas zonas
  // tenga cargadas.
  if (estado === 'Distrito Capital') return true;
  const siblings = Object.keys(CITY_TO_STATE).filter((c) => CITY_TO_STATE[c] === estado);
  return siblings.length === 1;
}

function formatAgency(a) {
  const distance = a.distanceKm !== undefined ? ` (~${a.distanceKm.toFixed(1)} km)` : '';
  const region = a.region ? ` — ${a.region}` : '';
  const phone = a.phone ? `\nTel: ${a.phone}` : '';
  return `*${a.name}*${region}${distance}\n${a.address}${phone}`;
}

// Detecta a que columna del CSV corresponde cada header del Excel, sin
// importar mayusculas/acentos/orden (para que sirva tanto la planilla de
// Tealca como cualquier otra parecida). Si no reconoce los headers, usa el
// orden de columnas tal cual viene (estado, agencia, direccion).
function normalizeHeader(h) {
  return String(h || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function importFromWorkbookBuffer(buffer) {
  // Se pide aca adentro (no arriba del archivo) para que el resto del bot
  // siga funcionando aunque la dependencia 'xlsx' no este instalada.
  const XLSX = require('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('El Excel no tiene hojas.');
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!rows.length) throw new Error('La hoja esta vacia.');

  const header = rows[0].map(normalizeHeader);
  let idxRegion = header.findIndex((h) => h.includes('estado') || h.includes('region'));
  let idxName = header.findIndex((h) => h.includes('agencia') || h === 'nombre' || h.includes('sucursal'));
  let idxAddress = header.findIndex((h) => h.includes('direccion'));
  let idxPhone = header.findIndex((h) => h.includes('telefono') || h.includes('tel'));
  let idxCountry = header.findIndex((h) => h.includes('pais'));

  // No reconocio los nombres de columna: asume el orden de Tealca
  // (estado, agencia, direccion) que es el formato mas comun.
  if (idxRegion === -1 && idxName === -1 && idxAddress === -1) {
    idxRegion = 0;
    idxName = 1;
    idxAddress = 2;
  }
  if (idxName === -1) throw new Error('No encontre una columna de nombre de agencia (ESTADO / AGENCIA / DIRECCION).');

  const dataRows = rows.slice(1);
  const parsed = [];
  for (const row of dataRows) {
    const name = String(row[idxName] ?? '').trim();
    if (!name) continue;
    parsed.push({
      name,
      country: idxCountry !== -1 ? String(row[idxCountry] ?? '').trim() || 'Venezuela' : 'Venezuela',
      region: idxRegion !== -1 ? String(row[idxRegion] ?? '').trim() : '',
      address: idxAddress !== -1 ? String(row[idxAddress] ?? '').trim() : '',
      phone: idxPhone !== -1 ? String(row[idxPhone] ?? '').trim() : '',
      lat: '',
      lon: '',
    });
  }

  if (!parsed.length) throw new Error('No encontre filas con agencias validas en el Excel.');

  writeCsv(parsed);
  return getMeta();
}

module.exports = {
  loadAgencies,
  nearestByCoords,
  searchByText,
  formatAgency,
  haversineKm,
  getMeta,
  importFromWorkbookBuffer,
  resolveStateForCity,
  findKnownCityKey,
  isSoleCityOfItsState,
};
