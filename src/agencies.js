// Carga agencies.csv y encuentra la agencia mas cercana a una ubicacion dada,
// o busca por texto (ciudad/pais) cuando no hay coordenadas.
const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, '..', 'data', 'agencies.csv');

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

// Devuelve las N agencias mas cercanas a una coordenada dada.
function nearestByCoords(lat, lon, limit = 3) {
  const agencies = loadAgencies().filter(
    (a) => !Number.isNaN(a.lat) && !Number.isNaN(a.lon)
    );
  return agencies
  .map((a) => ({ ...a, distanceKm: haversineKm(lat, lon, a.lat, a.lon) }))
  .sort((a, b) => a.distanceKm - b.distanceKm)
  .slice(0, limit);
}

// Busqueda por texto libre (ciudad o pais) cuando el usuario escribe en vez de compartir ubicacion.
function searchByText(query, limit = 5) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const agencies = loadAgencies();
  return agencies
  .filter(
    (a) =>
      a.city.toLowerCase().includes(q) ||
      a.country.toLowerCase().includes(q) ||
      a.name.toLowerCase().includes(q)
    )
  .slice(0, limit);
}

function formatAgency(a) {
  const distance =
    a.distanceKm !== undefined ? ` (~${a.distanceKm.toFixed(1)} km)` : '';
  return `*${a.name}*${distance}\n${a.address}\nTel: ${a.phone}`;
}

module.exports = { loadAgencies, nearestByCoords, searchByText, formatAgency, haversineKm };
