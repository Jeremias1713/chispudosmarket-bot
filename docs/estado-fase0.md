# Estado — Fase 0 (preparación)

Fecha: 9 de septiembre de 2026.

## Commit de referencia

- Commit auditado (informe de reparación): `91a0ec5e6ad3b52bff784ea37a463bb97abb8ef0`.
- Commit actual de `main` al iniciar la Fase 0: `a12c156e7f1dc61bf9236779eb1a660e43e835e8`.
- Diferencia: 3 commits ya aplicados después de la auditoría, todos relacionados
  con el mismo patrón "promesa incumplida → seguimiento automático" ya conocido
  en este proyecto (formularios/enlaces inexistentes que el modelo promete sin
  entregar en el mismo mensaje):
  - `fb2b635` Agrega `getDataRequestTemplate` y prohíbe prometer "formulario"/enlace en el prompt.
  - `efdedda` Nueva red de seguridad: si el bot promete un formulario/enlace inexistente, se manda el pedido de datos real automáticamente.
  - `a12c156` Simulador: paridad con la nueva red de seguridad de promesa de formulario/enlace.
- Estos 3 commits no invalidan ningún hallazgo H01–H41 de la auditoría; son
  independientes (tocan `ai.js`/`flow.js`/`simulator.js` en la zona de
  detección de promesas, ver `looksLikePendingFormPromise`).

## Versión de Node

- `package.json` declara `"engines": { "node": ">=18" }` (rango abierto, sin techo — hallazgo H30).
- Node instalado en este entorno de trabajo: `v22.22.2`.
- **Pendiente de confirmar en el dashboard de Render:** qué versión de Node usa
  realmente el servicio `srv-da89pg6k1f9s73cmk1ig` en producción. No se puede
  saber solo leyendo el repo; Render puede usar su propio default si no hay
  `.node-version` ni `NODE_VERSION` fijados. No se encontró ninguno de los dos
  en el repo.

## Persistencia de datos

Confirmado leyendo `src/state.js` y `src/settings.js` (comentarios ya
presentes en el propio código, coinciden con H04/H28 de la auditoría):

- Todos los datos (`sessions.json`, `products.json`, `settings.json`,
  `library.json`, `broadcasts.json`, `coupons.json`, `push-*.json`,
  `agencies.csv`, medios subidos) viven como archivos sueltos bajo `data/`,
  ignorados por git (`.gitignore`).
- El propio código ya advierte: *"en el plan gratuito de Render el disco no
  es persistente entre reinicios del servicio [...] así que este historial
  puede perderse"*.
- **Pendiente de confirmar en Render:** si el servicio tiene un "Persistent
  Disk" adjunto (planes pagos) o si sigue en el plan gratuito con disco
  efímero. Esto no se puede ver desde el repositorio; hay que revisarlo en el
  dashboard de Render antes de decidir la prioridad real de H04/H28 (si el
  disco ya es efímero, la pérdida de datos por reinicio es un problema mayor
  y más urgente que lo que refleja su prioridad actual).
- No se tocó ni se leyó ningún dato real del negocio en esta fase. Todo lo de
  abajo (fixtures, tests) usa datos ficticios en una carpeta temporal aparte.

## Auto-deploy / flujo de despliegue

Confirmado por las reglas fijas del proyecto (no se cambia en esta fase):

- Cambios se suben por la interfaz web de GitHub ("Upload files" + "Commit
  changes"), nunca `git push` local.
- Despliegue manual en Render: "Manual Deploy → Deploy latest commit" sobre
  el servicio `srv-da89pg6k1f9s73cmk1ig`, en vivo en
  `https://chispudosmarket-bot.onrender.com`.
- Esta fase (Fase 0) no requiere desplegar nada: los archivos que agrega
  (`src/dataDir.js`, `test/`, `docs/`) no cambian el comportamiento del bot
  en producción. Se recomienda igual hacer un deploy de prueba después de
  subir los cambios, únicamente para confirmar que el servicio sigue
  arrancando bien con los archivos nuevos (ver tarea de la fase 0: "Subir
  cambios... y confirmar sin deploy roto").

## Cambio de infraestructura introducido en esta fase

Se agregó `src/dataDir.js`, que centraliza la carpeta base de datos
(`DATA_DIR`) que ya usaban por separado `state.js`, `settings.js`,
`catalog.js`, `coupons.js`, `broadcasts.js`, `agencies.js`, `library.js` y
`push.js` (cada uno con su propio `path.join(__dirname, '..', 'data', ...)`).

- **Comportamiento en producción: sin cambios.** Si la variable de entorno
  `BOT_DATA_DIR` no está definida (nunca lo estará en Render salvo que
  alguien la agregue a propósito), `DATA_DIR` resuelve exactamente a la
  misma ruta `data/` de siempre.
- **Nuevo uso, solo para pruebas:** si se define `BOT_DATA_DIR` (por ejemplo
  apuntando a una carpeta temporal), todos esos módulos leen y escriben ahí
  en lugar de `data/`. Esto es lo que permite a la suite de `test/` crear
  fixtures ficticios (sesiones, catálogo, cupones, etc.) sin tocar ni
  arriesgar un solo archivo real del negocio.
- Se verificó manualmente (sin test automatizado adicional, solo un `node -e`
  puntual) que con `BOT_DATA_DIR` sin definir la ruta resuelta es idéntica a
  la anterior, y que con `BOT_DATA_DIR` definido cambia como se espera.
- Este cambio no toca ninguna lógica de negocio, cruces, montos, plantillas
  ni conversación — solo de dónde se lee/escribe el archivo. No cierra
  ningún hallazgo por sí solo; es infraestructura para poder probarlos.

## Qué falta para cerrar la Fase 0

Ver `docs/contratos.md` (contratos de pedido/mensaje/estados) y `test/`
(fixtures + primeras pruebas de regresión). Ninguna de las fases 1–9 debe
empezar sin que esto esté subido y confirmado en el repositorio.
