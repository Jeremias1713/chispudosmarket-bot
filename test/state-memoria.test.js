'use strict';
// Rendimiento con volumen: las sesiones se leen de memoria y los guardados se
// agrupan. Se prueba en un proceso aparte (fuera de node --test el guardado
// es diferido) que todo queda en el disco al terminar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STATE = path.join(__dirname, '..', 'src', 'state.js');

test('guardado diferido: lo pendiente se escribe al terminar el proceso', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-mem-'));
  const env = { ...process.env, BOT_DATA_DIR: dir, SESSIONS_FLUSH_MS: '60000' };
  delete env.NODE_TEST_CONTEXT;
  const script = `
    const st = require(${JSON.stringify(STATE)});
    const fs = require('fs');
    st.updateSession('584120000001', { note: 'a' });
    st.appendMessage('584120000001', 'user', 'hola');
    const s = st.getSession('584120000001');
    s.note = 'modificada afuera';
    if (st.getSession('584120000001').note !== 'a') throw new Error('la copia devuelta toca la memoria');
    if (fs.existsSync(${JSON.stringify(path.join(dir, 'sessions.json'))})) throw new Error('se escribio antes de tiempo');
  `;
  execFileSync(process.execPath, ['-e', script], { env });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
  assert.equal(saved['584120000001'].note, 'a');
  assert.equal(saved['584120000001'].history.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listSessions ve los cambios todavia no escritos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-mem-'));
  const env = { ...process.env, BOT_DATA_DIR: dir, SESSIONS_FLUSH_MS: '60000' };
  delete env.NODE_TEST_CONTEXT;
  const out = execFileSync(process.execPath, ['-e', `
    const st = require(${JSON.stringify(STATE)});
    st.updateSession('584120000002', { stage: 'vendido' });
    process.stdout.write(st.listSessions().find((x) => x.phone === '584120000002').stage);
  `], { env }).toString();
  assert.equal(out, 'vendido');
  fs.rmSync(dir, { recursive: true, force: true });
});
