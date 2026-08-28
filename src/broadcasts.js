// Envios masivos desde el panel: manda una plantilla de WhatsApp ya aprobada
// por Meta a un grupo de conversaciones (todas, o filtradas por etapa), y
// deja un historial de que se mando y a quien. A diferencia del bot.js
// original (que solo mandaba con Baileys, sin restriccion), la API oficial
// de Meta exige que un mensaje que el negocio inicia fuera de la ventana de
// 24h use una plantilla ya aprobada: por eso esto no manda texto libre.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendTemplate } = require('./whatsapp');
const { listSessions } = require('./state');

const RUNS_PATH = path.join(__dirname, '..', 'data', 'broadcasts.json');
const SEND_GAP_MS = 300;

function loadRuns() {
  try {
    return JSON.parse(fs.readFileSync(RUNS_PATH, 'utf8'));
  } catch (err) {
    return [];
  }
}

function saveRuns(runs) {
  fs.writeFileSync(RUNS_PATH, JSON.stringify(runs, null, 2));
}

function listRuns() {
  return loadRuns().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

// target: { scope: 'all' } o { scope: 'stage', stage: 'perdido' }
function resolveTargets(target) {
  const sessions = listSessions();
  if (target?.scope === 'stage' && target.stage) {
    return sessions.filter((s) => (s.stage || 'nuevo') === target.stage).map((s) => s.phone);
  }
  return sessions.map((s) => s.phone);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Corre en el fondo (no bloquea la respuesta HTTP): el panel arranca el run
// y despues consulta el progreso por polling, como cualquier otro dato.
async function startRun({ templateName, languageCode, params, target }) {
  const phones = resolveTargets(target);
  const run = {
    id: crypto.randomBytes(6).toString('hex'),
    templateName,
    languageCode: languageCode || 'es',
    params: params || [],
    target,
    total: phones.length,
    sent: 0,
    failed: 0,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    results: [],
  };

  const runs = loadRuns();
  runs.push(run);
  saveRuns(runs);

  (async () => {
    for (const phone of phones) {
      let ok = true;
      let error = null;
      try {
        await sendTemplate(phone, templateName, run.languageCode, run.params);
      } catch (err) {
        ok = false;
        error = err.response?.data?.error?.message || err.message;
      }

      const current = loadRuns();
      const r = current.find((x) => x.id === run.id);
      if (!r) break; // el run se borro mientras corria
      r.results.push({ phone, ok, error, at: new Date().toISOString() });
      r.sent += ok ? 1 : 0;
      r.failed += ok ? 0 : 1;
      saveRuns(current);

      await sleep(SEND_GAP_MS);
    }

    const current = loadRuns();
    const r = current.find((x) => x.id === run.id);
    if (r) {
      r.status = 'done';
      r.finishedAt = new Date().toISOString();
      saveRuns(current);
    }
  })();

  return run;
}

module.exports = { listRuns, startRun, resolveTargets };
