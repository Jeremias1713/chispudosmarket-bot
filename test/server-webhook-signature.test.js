// FASE 1 (H01): antes, cualquiera que conociera la URL de /webhook podia
// mandarle un POST fabricado a mano y el bot lo procesaba como un mensaje
// real (incluyendo hacer que la IA "conteste"). Ahora, si WHATSAPP_APP_SECRET
// esta configurado, el webhook verifica la firma HMAC-SHA256 que manda Meta
// (X-Hub-Signature-256) antes de dejar pasar el POST.
//
// Se prueba la logica de verificacion directamente (computeExpectedSignature
// / verifyWebhookSignature) con objetos req/res/next simulados, sin levantar
// un servidor HTTP real ni depender de ninguna libreria extra: server.js ya
// evita bindear el puerto al ser require()-eado (ver "require.main ===
// module" en server.js), asi que alcanza con importar el modulo.
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const SECRET = 'un-secreto-de-prueba-cualquiera';

function requireServerWithSecret(secret) {
  delete require.cache[require.resolve('../src/server')];
  if (secret === undefined) {
    delete process.env.WHATSAPP_APP_SECRET;
  } else {
    process.env.WHATSAPP_APP_SECRET = secret;
  }
  return require('../src/server');
}

function fakeReqRes(rawBody, signatureHeader) {
  const req = {
    rawBody: Buffer.from(rawBody),
    get(name) {
      if (name.toLowerCase() === 'x-hub-signature-256') return signatureHeader;
      return undefined;
    },
  };
  let statusSent = null;
  const res = {
    sendStatus(code) {
      statusSent = code;
      return res;
    },
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };
  return { req, res, next, wasNextCalled: () => nextCalled, statusSent: () => statusSent };
}

describe('H01 - verificacion de firma del webhook (X-Hub-Signature-256)', () => {
  test('sin WHATSAPP_APP_SECRET configurado, deja pasar el POST igual que antes (no rompe produccion sin migrar)', () => {
    const { verifyWebhookSignature } = requireServerWithSecret(undefined);
    const { req, res, next, wasNextCalled, statusSent } = fakeReqRes('{"hola":"mundo"}', undefined);

    verifyWebhookSignature(req, res, next);

    assert.equal(wasNextCalled(), true, 'sin secreto configurado, next() se llama (no bloquea)');
    assert.equal(statusSent(), null, 'no se responde con 403 si no hay secreto configurado');
  });

  test('con WHATSAPP_APP_SECRET configurado, una firma valida deja pasar el mensaje', () => {
    const { verifyWebhookSignature, computeExpectedSignature } = requireServerWithSecret(SECRET);
    const body = '{"entry":[{"changes":[{"value":{"messages":[{"from":"584120000000"}]}}]}]}';
    const firmaValida = computeExpectedSignature(Buffer.from(body));

    const { req, res, next, wasNextCalled, statusSent } = fakeReqRes(body, firmaValida);
    verifyWebhookSignature(req, res, next);

    assert.equal(wasNextCalled(), true, 'una firma valida deja pasar el mensaje legitimo');
    assert.equal(statusSent(), null);
  });

  test('con WHATSAPP_APP_SECRET configurado, una firma ausente o fabricada se rechaza con 403 y NUNCA llega a next() (nunca se ejecuta la IA)', () => {
    const { verifyWebhookSignature } = requireServerWithSecret(SECRET);
    const body = '{"entry":[{"changes":[{"value":{"messages":[{"from":"584120000000"}]}}]}]}';

    // Caso 1: sin header de firma.
    const sinFirma = fakeReqRes(body, undefined);
    verifyWebhookSignature(sinFirma.req, sinFirma.res, sinFirma.next);
    assert.equal(sinFirma.wasNextCalled(), false, 'BUG H01 corregido: sin firma, next() NO se llama (la IA no llega a ejecutarse)');
    assert.equal(sinFirma.statusSent(), 403);

    // Caso 2: firma fabricada a mano (lo que mandaria un atacante que no
    // conoce el App Secret real).
    const firmaFalsa = 'sha256=' + crypto.createHmac('sha256', 'secreto-incorrecto').update(body).digest('hex');
    const conFirmaFalsa = fakeReqRes(body, firmaFalsa);
    verifyWebhookSignature(conFirmaFalsa.req, conFirmaFalsa.res, conFirmaFalsa.next);
    assert.equal(conFirmaFalsa.wasNextCalled(), false, 'BUG H01 corregido: firma invalida, next() NO se llama');
    assert.equal(conFirmaFalsa.statusSent(), 403);
  });

  test('la firma se calcula sobre el cuerpo crudo exacto: cambiar un solo byte del body invalida una firma que antes era valida', () => {
    const { verifyWebhookSignature, computeExpectedSignature } = requireServerWithSecret(SECRET);
    const bodyOriginal = '{"a":1}';
    const bodyAlterado = '{"a":2}';
    const firmaDelOriginal = computeExpectedSignature(Buffer.from(bodyOriginal));

    const { req, res, next, wasNextCalled, statusSent } = fakeReqRes(bodyAlterado, firmaDelOriginal);
    verifyWebhookSignature(req, res, next);

    assert.equal(wasNextCalled(), false, 'un body distinto al firmado se rechaza aunque la firma "parezca" valida para otro payload');
    assert.equal(statusSent(), 403);
  });
});
