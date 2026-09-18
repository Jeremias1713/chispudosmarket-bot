'use strict';

// Normaliza texto para que el buscador del panel no dependa de mayusculas,
// tildes o signos. Se mantiene separado del router para poder probarlo sin
// levantar Express ni leer el archivo completo de sesiones.
function foldSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function closeToken(queryToken, candidateToken) {
  if (queryToken === candidateToken) return true;
  const longest = Math.max(queryToken.length, candidateToken.length);
  if (longest < 5) return false;
  const allowedDistance = longest >= 8 ? 2 : 1;
  if (Math.abs(queryToken.length - candidateToken.length) > allowedDistance) return false;
  return editDistance(queryToken, candidateToken) <= allowedDistance;
}

function conversationSearchText(session) {
  const card = session?.card || {};
  const history = Array.isArray(session?.history) ? session.history : [];
  const values = [
    session?.phone,
    session?.name,
    card.nombre,
    card.telefono,
    card.ciudad,
    card.producto,
    card.notas,
    session?.internalNote,
    ...history.map((message) => message?.content),
  ];
  return foldSearchText(values.filter(Boolean).join(' '));
}

function matchesConversation(session, rawQuery) {
  const query = foldSearchText(rawQuery);
  if (!query) return true;

  const searchable = conversationSearchText(session);
  if (searchable.includes(query)) return true;

  // Para nombres con pequenos errores (Sainer/Xainer, Santoya/Santolla),
  // exige que TODAS las palabras de la consulta tengan una palabra cercana.
  // Esto evita que una sola coincidencia comun, como "Jose", muestre todos
  // los Jose de la base.
  const queryTokens = query.split(' ').filter(Boolean);
  const candidateTokens = [...new Set(searchable.split(' ').filter(Boolean))];
  return queryTokens.every((queryToken) =>
    candidateTokens.some((candidateToken) => closeToken(queryToken, candidateToken))
  );
}

module.exports = { foldSearchText, conversationSearchText, matchesConversation };
