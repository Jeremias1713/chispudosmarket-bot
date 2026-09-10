// FASE 3 (H05/H18): logica de comparacion de nombres COMPARTIDA entre los
// dos cruces por Excel que tiene el bot (dropanas.js y seguimiento.js).
// Antes cada archivo tenia su propia copia de foldName() y su propio
// criterio de "cuando dos nombres son la misma persona" (una simple
// comparacion `a.includes(b) || b.includes(a)`), lo que producia falsos
// positivos peligrosos: "Ana" contra "Ana Maria" quedaba clasificado como
// coincidencia UNICA/exacta (si esa era la unica sesion parecida), aunque
// "Ana" es evidencia demasiado debil para decidir solo.
//
// Regla nueva, mas estricta para "exacto" y mas permisiva para detectar
// coincidencias legitimas con nombres intercalados:
//   - Se comparan como CONJUNTOS DE PALABRAS (orden no importa, apellidos
//     invertidos tambien matchean), ya normalizados (sin tildes, minuscula).
//   - Si los dos conjuntos son iguales -> 'exacto'.
//   - Si el conjunto MAS CHICO tiene 2 o mas palabras y esta CONTENIDO
//     entero en el mas grande (ej. "Jose Velasquez" dentro de "Jose
//     Gregorio Velasquez") -> 'exacto': dos apellidos/nombres coincidiendo
//     es evidencia suficiente, un nombre de por medio no cambia quien es.
//   - Si comparten al menos una palabra pero no se cumple lo anterior (ej.
//     "Ana" contra "Ana Maria": una sola palabra en comun, no alcanza para
//     decidir solo) -> 'parcial': se sugiere como candidato, pero SIEMPRE
//     requiere confirmacion manual, nunca se auto-marca.
//   - Si no comparten ninguna palabra -> 'sin_match'.
function foldName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[Ì€-\¯]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function nameTokens(s) {
  const folded = foldName(s);
  if (!folded) return [];
  return folded.split(' ').filter(Boolean);
}

// Compara dos nombres y devuelve 'exacto' | 'parcial' | 'sin_match'.
function compareNames(nameA, nameB) {
  const tokensA = nameTokens(nameA);
  const tokensB = nameTokens(nameB);
  if (!tokensA.length || !tokensB.length) return 'sin_match';

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  const [smaller, bigger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  const interseccion = [...smaller].filter((t) => bigger.has(t));

  if (interseccion.length === 0) return 'sin_match';

  const sonIguales = smaller.size === bigger.size && interseccion.length === smaller.size;
  if (sonIguales) return 'exacto';

  // El conjunto mas chico esta contenido entero en el mas grande, y tiene
  // por lo menos 2 palabras: suficiente para no ser una casualidad de
  // nombre de pila compartido.
  const contenidoEntero = interseccion.length === smaller.size && smaller.size >= 2;
  if (contenidoEntero) return 'exacto';

  return 'parcial';
}

function normalizePhoneDigits(s) {
  return String(s || '').replace(/\D/g, '');
}

// Compara dos telefonos: alcanza con que uno termine con el otro (los
// ultimos digitos suelen ser el numero real sin el prefijo internacional).
// Limitacion conocida: el "0" inicial de un numero local venezolano
// (0412-...) no tiene equivalente en el formato internacional (58412...),
// asi que ese caso puntual (local CON el 0 vs internacional) puede no
// matchear. Ningun llamador actual depende de esto (el Excel de Dropanas
// todavia no trae columna de telefono); si en el futuro se usa con datos
// reales de telefono, conviene revisar ese caso primero.
function phonesMatch(phoneA, phoneB) {
  const a = normalizePhoneDigits(phoneA);
  const b = normalizePhoneDigits(phoneB);
  if (!a || !b) return false;
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 7) return false; // muy corto para comparar con confianza
  return a.slice(-min) === b.slice(-min);
}

module.exports = { foldName, nameTokens, compareNames, normalizePhoneDigits, phonesMatch };
