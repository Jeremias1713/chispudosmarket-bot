// Envios masivos desde el panel: manda una plantilla de WhatsApp ya aprobada
// por Meta a un grupo de conversaciones (todas, o filtradas por etapa), y
// deja un historial de que se mando y a quien. A diferencia del bot.js
// original (que solo mandaba con Baileys, sin restriccion), la API oficial
// de Meta exige que un mensaje que el negocio inicia fuera de la ventana de
// 24h use una plantilla ya aprobada: por eso esto no manda texto libre.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendTemplateWithSnapshot } = require('./templateSend');
const { listSessions, appendMessage } = require('./state');
const { DATA_DIR } = require('./dataDir');
const { canSendAutomatic, reserveAutomatic } = require('./outboundGuard');

const RUNS_PATH = path.join(DATA_DIR, 'broadcasts.json');
// Pausa entre mensajes: mas lenta a proposito (antes 300 ms) para no parecer spam.
const SEND_GAP_MS = 1500;

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

// FASE 3d: mismo respaldo de codigo que ya tienen shipping.js, seguimiento.js
// y POST /api/conversations/:phone/send-template (ver panel.js linea ~354) --
// a Meta le alcanza con que UN SOLO parametro llegue vacio ("") para mandar
// la plantilla entera SIN reemplazar NINGUNA variable (el cliente ve
// literalmente "Hola {{1}}, tu pedido de {{2}}..."). Este envio masivo
// generico era el UNICO lugar que todavia no tenia este respaldo: si el
// campo de variables se dejaba vacio ((o con algun campo en blanco entre
// comas) en el panel, el bug se disparaba de verdad, a TODOS los clientes
// del filtro elegido a la vez. Ahora, aca tambien, cualquier variable vacia
// se manda como "-" en vez de "".
function sanitizeParams(params) {
  return (Array.isArray(params) ? params : []).map((p) => {
    const v = String(p ?? '').trim();
    return v || '-';
  });
}

// Corre en el fondo (no bloquea la respuesta HTTP): el panel arranca el run
// y despues consulta el progreso por polling, como cualquier otro dato.
async function startRun({ templateName, languageCode, params, target, headerImageUrl }) {
  const phones = resolveTargets(target);
  const run = {
    id: crypto.randomBytes(6).toString('hex'),
    templateName,
    languageCode: languageCode || 'es',
    params: sanitizeParams(params),
    // FASE 3d: antes este envio nunca mandaba imagen de encabezado (aunque
    // la plantilla elegida la necesitara, ej. guia_del_pedido), sin avisar
    // nada -- Meta manda igual el texto pero sin la foto. Ahora se puede
    // pasar una URL de imagen, igual que ya se podia en la prueba individual
    // de una plantilla (ver /api/templates/:name/test-send).
    headerImageUrl: headerImageUrl || null,
    target,
    total: phones.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    results: [],
  };

  const runs = loadRuns();
  runs.push(run);
  saveRuns(runs);

  (async () => {
    const byPhone = new Map(listSessions().map((x) => [x.phone, x]));
    for (const phone of phones) {
      let ok = true;
      let error = null;
      let wamid = null;
      let skippedReason = null;
      const session = byPhone.get(phone) || null;
      // Guardia comun de envios automaticos: opt-out, tope diario, horario y
      // calidad en riesgo. Los saltados quedan en el resultado con su motivo.
      const guard = canSendAutomatic(session, 'broadcast');
      if (!guard.ok) {
        skippedReason = guard.reason;
      } else {
      try {
        if (session) reserveAutomatic(phone, 'broadcast', new Date(), session);
        // FASE 2/5 (H06/H35): antes se mandaba con sendTemplate directo y en
        // el historial solo quedaba el string "[plantilla masiva] nombre",
        // sin el contenido real armado ni el wamid (necesario para saber
        // despues si se entrego/leyo, via el webhook de status).
        const resultado = await sendTemplateWithSnapshot({
          to: phone,
          templateName,
          languageCode: run.languageCode,
          values: run.params,
          headerImageUrl: run.headerImageUrl,
        });
        wamid = resultado.wamid;
        // BUG YA CORREGIDO ((mismo que el de seguimiento.js): el envio masivo
        // SI mandaba de verdad la plantilla por WhatsApp, pero nunca quedaba
        // guardado en el historial de la conversacion de cada cliente, asi
        // que en el chat individual no se veia ningun rastro del envio.
        try {
          appendMessage(phone, 'human', `[plantilla masiva] ${templateName}`, {
            template: { name: templateName, origin: 'broadcast', params: run.params, snapshot: resultado.snapshot, wamid, status: 'sent' },
          });
        } catch (logErr) {
          console.error('La plantilla masiva salio pero no se pudo guardar en el historial de', `…${String(phone).slice(-4)}`, logErr.message);
        }
      } catch (err) {
        ok = false;
        error = err.response?.data?.error?.message || err.message;
      }
      }

      const current = loadRuns();
      const r = current.find((x) => x.id === run.id);
      if (!r) break; // el run se borro mientras corria
      if (skippedReason) {
        r.results.push({ phone, ok: false, skipped: true, reason: skippedReason, error: null, wamid: null, at: new Date().toISOString() });
        r.skipped = (r.skipped || 0) + 1;
      } else {
        r.results.push({ phone, ok, error, wamid, at: new Date().toISOString() });
        r.sent += ok ? 1 : 0;
        r.failed += ok ? 0 : 1;
      }
      saveRuns(current);

      if (!skippedReason) await sleep(SEND_GAP_MS);
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
