// Eventos de cuenta que Meta manda al webhook (ademas de mensajes y statuses):
// calidad del numero, calidad y estado de las plantillas. Antes el webhook
// solo leia entry[0].changes[0] y no procesaba estos eventos, asi que el bot
// no se enteraba cuando Meta bajaba la calidad. Jere tiene que suscribir los
// campos phone_number_quality_update, message_template_quality_update y
// message_template_status_update en developers.facebook.com (WhatsApp >
// Configuracion > Campos del webhook); sin eso Meta no los manda.
'use strict';

const FAIL_ALERT_THRESHOLD = 10;
const FAIL_CODE_HINTS = {
  131049: 'Meta limita marketing a ese usuario',
  131026: 'no se pudo entregar',
  131047: 'fuera de la ventana de 24 h',
  131050: 'el usuario dejo de recibir marketing',
};

function defaultDeps() {
  return {
    settings: require('./settings'),
    notifyAdmin: (title, body) => require('./push').notifyAdmin(title, body),
    now: () => new Date(),
  };
}

function safeNotify(deps, title, body) {
  try {
    const p = deps.notifyAdmin(title, body);
    if (p && p.catch) p.catch(() => {});
  } catch (err) {
    console.error('No se pudo avisar por push:', err.message);
  }
}

// change: un elemento de entry[].changes[] del webhook. Devuelve true si era un
// evento de cuenta (y se proceso). Nunca lanza.
function handleAccountChange(change, overrides = {}) {
  try {
    const deps = { ...defaultDeps(), ...overrides };
    const field = change?.field;
    const value = change?.value || {};
    const at = deps.now().toISOString();

    if (field === 'phone_number_quality_update') {
      const quality = { event: value.event || null, currentLimit: value.current_limit || null, at };
      const patch = { whatsappQuality: quality };
      if (value.event === 'FLAGGED' || value.event === 'DOWNGRADE') {
        patch.qualityGuardActive = true;
        safeNotify(deps, 'Meta bajó la calidad del número', 'Se pausaron remarketing, recordatorios y masivos. Revisa Configuración → Calidad del número.');
      } else {
        // UNFLAGGED / UPGRADE: solo se guarda y se avisa; la guardia la apaga Jere.
        safeNotify(deps, 'Calidad del número actualizada', `Meta avisó: ${value.event || 'cambio'}. La guardia sigue como estaba; apágala en Configuración cuando quieras.`);
      }
      deps.settings.updateSettings(patch);
      return true;
    }

    if (field === 'message_template_quality_update') {
      const name = value.message_template_name;
      if (!name) return true;
      const current = deps.settings.getSettings().templateQuality || {};
      const next = { ...current, [name]: { score: value.new_quality_score || null, previous: value.previous_quality_score || null, at } };
      deps.settings.updateSettings({ templateQuality: next });
      const score = String(value.new_quality_score || '').toUpperCase();
      if (score === 'YELLOW' || score === 'RED') safeNotify(deps, 'Calidad de plantilla', `La plantilla ${name} bajó a ${score}.`);
      return true;
    }

    if (field === 'message_template_status_update') {
      const name = value.message_template_name;
      if (!name) return true;
      const current = deps.settings.getSettings().templateStatus || {};
      const next = { ...current, [name]: { event: value.event || null, reason: value.reason || null, at } };
      deps.settings.updateSettings({ templateStatus: next });
      const event = String(value.event || '').toUpperCase();
      if (event === 'PAUSED' || event === 'DISABLED') safeNotify(deps, 'Estado de plantilla', `La plantilla ${name} quedó ${event}.`);
      return true;
    }
    return false;
  } catch (err) {
    console.error('Error procesando evento de cuenta de Meta:', err.message);
    return false;
  }
}

// Contador (en memoria, por dia) de envios que Meta reporta como fallidos.
let failures = { date: null, count: 0, alerted: false };

function resetFailureCounter() {
  failures = { date: null, count: 0, alerted: false };
}

function noteFailedStatus(statusEvent, overrides = {}) {
  try {
    if (!statusEvent || statusEvent.status !== 'failed') return;
    const deps = { ...defaultDeps(), ...overrides };
    const today = deps.now().toISOString().slice(0, 10);
    if (failures.date !== today) failures = { date: today, count: 0, alerted: false };
    failures.count += 1;
    if (failures.count > FAIL_ALERT_THRESHOLD && !failures.alerted) {
      failures.alerted = true;
      const code = statusEvent.errors?.[0]?.code;
      const hint = FAIL_CODE_HINTS[code] ? ` (${FAIL_CODE_HINTS[code]})` : '';
      safeNotify(deps, 'Fallos de envío en WhatsApp', `Hoy fallaron ${failures.count} envíos de WhatsApp (último código: ${code || 'desconocido'}${hint}).`);
    }
  } catch (err) {
    console.error('Error contando fallos de WhatsApp:', err.message);
  }
}

module.exports = { handleAccountChange, noteFailedStatus, resetFailureCounter, FAIL_ALERT_THRESHOLD };
