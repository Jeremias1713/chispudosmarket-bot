# Informe — Revisión "conversación flexible, cierre estricto" (v3.1)

Fecha: 18 de septiembre de 2026.
Rama de trabajo (aislada, sin push/merge/deploy): `audit-cierre-flexible-20260918`, sobre `main` (`86d5731`).
Commits de esta revisión (en orden, cada uno revisable/desplegable por separado — ver punto 9 de tu
tercer mensaje): `06e3fb3`, `06f29a7`, `750b851` (remarketing), `6e8d51d` (validación v2 + scrub),
`466ac37` (harness de evaluación), `453daf2` (este informe, v2), `d1b7b3d` (**validación v3**),
`318cbf7` (harness: soporte de catálogo real), `c624b9b` (informe v3), y el harness de evaluación
reescrito de esta ronda (v3.1, ver sección 6 y 7).

Esta es la v3.1 del informe. Todavía **no autorizaste el despliegue**: nada de esto se pusheó, mergeó ni
desplegó. Los commits `750b851`/`6e8d51d`/`466ac37` son el mismo trabajo de la v2, pero ahora
**separados en commits independientes** (antes estaban mezclados en uno solo, `ab8fb03`, que ya no
existe en esta rama — se reescribió el historial local, sin tocar nada compartido).

> **⚠️ Aviso que pediste explícitamente: qué es real y qué es simulado en este informe.**
> Dos cosas MUY distintas conviven en este documento y hay que leerlas por separado:
> - **Simulado / determinístico** (secciones 1 y 3, la mayoría de la matriz de la sección 5): el texto
>   del bot en esos casos es un string **escrito a mano en el propio test** (`replyToReturn.text = '...'`
>   en `test/*.test.js`) — el modelo real de OpenAI **nunca se llamó** para producir ese texto. Lo que
>   esos tests prueban es el **código determinístico** (`evaluateOrderCompleteness`, el guard de
>   `flow.js`, etc.): que, dado CUALQUIER texto (inventado o real) con cierta forma, el sistema decide
>   correctamente si cierra o no, y guarda el estado correcto. Es una prueba real del código, pero con
>   una entrada de texto simulada, no generada por IA.
> - **Modelo real** (sección 6 y 7): la única evidencia que sale de una llamada real a `ai.getAssistantReply`
>   (y al clasificador) contra OpenAI. Esta ronda dejé el harness (`eval/model-eval.js`) listo y
>   verificado mecánicamente con respuestas de prueba fijas (ver sección 6.1), pero **todavía no lo corrí
>   contra el modelo real**: sigue sin `OPENAI_API_KEY` y sin tus prompts reales. Hasta que lo corra, no
>   hay ninguna respuesta real del modelo citada en este informe — y cuando la haya, la voy a marcar
>   explícitamente como tal, nunca mezclada con los casos simulados de la sección 1.

## 0. Bloqueos reales que siguen sin resolverse (te los señalo primero, no los escondo)

Siguen abiertos los dos mismos bloqueos de la v2, sin cambios — no los inflo ni los doy por resueltos
solo porque avancé en otras cosas:

**(a) No tengo acceso a los prompts de producto ni a la configuración real del panel.** No hay ningún
archivo adjunto a esta conversación, y el repositorio solo tiene `data/products.example.json` (productos
de ejemplo con textos placeholder). Los prompts por producto reales viven en `products.json`/`settings.json`
en el disco de Render de producción, que este entorno no puede leer. Por eso las frases que mencionaste
("primeros días", "a medio camino", "formulario automático") siguen sin poder corregirse en su origen —
solo reforcé el filtro de código (`scrubUnverifiedResultClaims`, sin cambios en esta ronda).

**Para tu punto 7 ("ejecuta la evaluación con los prompts reales que te voy a pegar")**: preparé el
mecanismo (`eval/real-products.local.json`, sección 6), pero **todavía no me pegaste ese texto real**. Sin
él, el harness sigue evaluando con un producto de prueba genérico, no con tus prompts reales.

**(b) No hay `OPENAI_API_KEY` en este entorno.** Verifiqué con `env | grep -i OPENAI`: no existe ninguna
variable de ese tipo. Dijiste "usaré una credencial de prueba mediante configuración segura, no pegada en
el chat" — **todavía no sé por qué canal concreto llegaría esa credencial a este entorno aislado**. No
existe hoy ningún mecanismo de configuración segura conectado a esta sesión (no hay `.env` sincronizado,
no hay secretos de este workspace conectados a una bóveda externa). Si tenés en mente pegarla como
variable de entorno al iniciar el proceso (`OPENAI_API_KEY=sk-... node eval/model-eval.js`) eso funciona
y nunca queda en el chat ni en el historial de git — pero necesito que confirmes que ese es el canal, o
me digas cuál otro preferís, porque no puedo asumirlo.

Ninguno de los dos bloqueos es una elección mía: son la falta de dos insumos que solo vos podés dar
(el texto real de los prompts, y la credencial). Todo lo demás de esta ronda (puntos 1 a 6 y 8 a 9) sí
lo resolví con el código y las pruebas que siguen abajo.

## 1. Validación de pedido completo — v3, con los 6 casos que exigiste demostrados uno por uno

**[SIMULADO]** Todos los "textos del bot" citados en esta sección (1.2 a 1.7) son strings escritos a mano
en el test correspondiente (`replyToReturn.text = '...'`), NO respuestas generadas por el modelo real —
`ai.getAssistantReply` está mockeado en esos archivos de test. Lo que se prueba con evidencia real es el
**código determinístico**: dado ese texto (cualquiera sea su origen), `evaluateOrderCompleteness` y el
guard de `flow.js` deciden correctamente si el pedido cierra y qué queda guardado. La verificación de que
el modelo real efectivamente REDACTA texto con ese patrón está en la sección 6/7, todavía pendiente de
ejecutarse.

### 1.1 Qué cambió respecto a v2 y por qué

Tu tercer mensaje fue explícito: "no acepto como cierre estricto las cinco señales descritas" de la v2.
Las 5 señales de la v2 (identidad, producto, cantidad, modalidad/destino, aceptación) seguían siendo
demasiado laxas en 4 de los 5 chequeos. Ahora son **7 señales** (`evaluateOrderCompleteness` en
`src/ai.js`), con el detalle de qué cuenta y qué no en cada una reescrito. Debajo, cada punto de tu
mensaje con: el caso de prueba real, la respuesta real involucrada, y el estado final guardado — no
solo "hay un test".

### 1.2 Punto 1 — "ciudad conocida no equivale a destino resuelto"

Antes: `knownCity` sola alcanzaba. Ahora `destinoYaResuelto` exige una de tres cosas:
`cardAgencia` ya cargada en la ficha, una selección inequívoca de agencia en el texto
(`looksLikeAgencySelected`: "la agencia 1", "la opción 2", "esa agencia me sirve", "agencia de El Vigía"),
o una dirección real (`looksLikeDeliveryAddressGiven`: exige una palabra de calle/sector/referencia —
"Av Libertador casa 5", no la palabra "domicilio" sola).

**Caso y resultado (`test/flow-order-close-guard.test.js`):**
- *"delivery a domicilio: decir SOLO la palabra 'domicilio' (sin una direccion real) NO alcanza"*:
  cliente escribe "dale, quiero 3 a domicilio. Carlos Perez, cedula 12345678, telefono 04121234567" (sin
  dirección). Respuesta del bot: *"Listo! Te llevamos 3 Shilajit (Bs 1050) a domicilio..."*. **Estado
  final guardado: `orderClosed` distinto de `true`** — no cierra, aunque el bot ya haya redactado un
  cierre completo.
- *"delivery a domicilio en Caracas... SI cierra con una direccion real"*: mismo escenario, pero el
  cliente agrega "Av Libertador casa 5, cerca de la plaza". **Estado final: `orderClosed: true`,
  `stage: 'vendido'`.**
- Ciudad sola sigue sin alcanzar: test unitario *"destino NO resuelto solo con knownCity"* en
  `ai-closing-message.test.js` confirma que `evaluateOrderCompleteness` devuelve `missing` con
  `modalidad_destino` cuando solo hay `knownCity`, sin agencia ni dirección.

### 1.3 Punto 2 — "un mensaje que no sea sí/ok/sticker no equivale a aceptar"

Se agregó `looksLikeHoldOrRetraction` (frases de freno: "no me lo mandes todavía", "espera", "solo
estoy consultando", "cancela") y `PURE_PRICE_QUESTION_RE` (preguntas de precio puras), ambas evaluadas
ANTES de aceptar cualquier mensaje largo como aceptación válida. Se agregó también
`looksLikeContextualShortAcceptance`: un "sí" corto SÍ cuenta, pero solo si responde directo a un mensaje
del bot que pide confirmación (`CONFIRMATION_REQUEST_RE`: "¿confirmas?", "¿te parece?", "¿así queda?").

**Casos concretos (`ai-closing-message.test.js`), con la entrada y el resultado exacto:**
- `"¿cuánto cuestan dos?"` → `looksLikeUnambiguousEngagement` devuelve `false` (es una pregunta de
  precio, no una aceptación) → `evaluateOrderCompleteness` marca `aceptacion_no_ambigua` como faltante.
- `"no me lo envíes todavía"` → `looksLikeHoldOrRetraction` devuelve `true` → bloquea el cierre **aunque
  el resto de los datos del pedido esté completo en la misma ventana** (test dedicado a este caso exacto).
- `"antes quería dos, ahora solo estoy consultando"` → matchea la retractación explícita → no cuenta
  como aceptación.
- Aceptación contextual válida: `lastAssistantText` = *"¿Así confirmamos tu pedido?"*, `lastUserMessage`
  = `"si"` → `looksLikeContextualShortAcceptance` devuelve `true` → SÍ cuenta como aceptación.
- El mismo escenario pero con `lastUserMessage = "no me lo envíes todavía"` respondiendo a esa misma
  pregunta → sigue bloqueando: el rechazo explícito gana incluso en el contexto de una pregunta de
  confirmación (test *"el rechazo explicito gana"*).

### 1.4 Punto 3 — cierre de delivery sin "Tealca"/"agencia"/"guía"

`isClosingMessage` ya no depende de esas 3 palabras. `looksLikeClosingSummaryText` es ahora estructural:
exige mención de pago (contra entrega/anticipado/efectivo/transferencia) **y** (recap del pedido **o**
lenguaje de seguimiento — guía, agencia, "en camino", "te aviso cuando llegue", mensajero).

**Caso real (`flow-order-close-guard.test.js`)**: respuesta del bot *"Listo! Te llevamos 3 Shilajit
(Bs 1050) a tu dirección. El pago es contra entrega, en efectivo o pago móvil. En cuanto el mensajero
esté en camino te aviso. ✅"* — el test verifica en código, antes de mandar el mensaje, que ese texto NO
contiene "tealca", "agencia" ni "guia" (`assert.ok(!/tealca|agencia|guia/i.test(...))`), y aun así, con
dirección real + resto de factores completos, **el estado final es `orderClosed: true`,
`stage: 'vendido'`**.

### 1.5 Punto 4 — presentación y total comunicado y aceptado

Dos señales nuevas, independientes de producto+cantidad:
- **Presentación** (`looksLikePresentationConfirmed`): si el catálogo tiene más de una variante con el
  mismo nombre base (ej. "Shilajit resina" y "Shilajit cápsulas"), no alcanza con el nombre genérico —
  el cliente tiene que haber mencionado la palabra distintiva. Con una sola variante activa, no aplica
  (no hay ambigüedad que resolver). Probado con un catálogo de dos productos escrito directo al
  `dataDir` de prueba (ver Errores/limitaciones técnicas más abajo por qué no se usó un segundo
  directorio temporal).
- **Total comunicado** (`looksLikeTotalCommunicated`): el texto de cierre en sí tiene que mencionar un
  monto en bolívares (`MONEY_MENTION_RE`, ej. "Bs 700"). Test *"falta solo el total comunicado"*: mismo
  cierre completo en todo lo demás, pero sin ningún "Bs" en el texto → `missing` incluye
  `total_comunicado`.

### 1.6 Punto 5 — no perder datos del pedido actual, no reutilizar datos de uno anterior

Se eliminó la ventana fija de "últimos N mensajes". Ahora `flow.js` busca hacia atrás en el historial el
último mensaje del bot que matchea `looksLikeClosingSummaryText` (el cierre anterior real, si existe) y
usa **todo lo que vino después de ese punto** como la ventana del pedido actual
(`segmentoPedidoActual`/`recentUserText`). Efecto directo:
- Un pedido válido dicho hace muchos turnos, sin ningún cierre de por medio, sigue disponible: ya no se
  "pierde" un cierre válido por antigüedad dentro de la conversación (tu objeción explícita a la v2).
- Cantidad o aceptación de una compra YA cerrada no se reutilizan para inflar un pedido nuevo: la
  búsqueda nunca cruza hacia atrás del cierre anterior.
- Caso ya cubierto por diseño (sin test dedicado nuevo, marcado así en la matriz): cuando no hay ningún
  cierre previo en el historial, la ventana es la conversación completa desde el inicio — eso ya estaba
  ejercitado indirectamente por los tests de "CLIENTE ANTIGUO" (ficha con datos viejos, sin cierre
  previo en el historial de esta sesión de prueba).

### 1.7 Punto 6 — el bot nunca dice "confirmado" si el sistema no puede guardarlo así

Nuevo guard en `flow.js`, ejecutado **antes** de `sendReply` (no después — ver "Errores corregidos por
mí mismo" más abajo, encontré y corregí este orden mientras lo implementaba): si la respuesta que iba a
mandarse tiene forma de cierre pero `evaluateOrderCompleteness` la marca incompleta,
`finalReply` se reemplaza por un aviso honesto (`buildIncompleteOrderNotice`, ej. *"Vamos bien, pero
antes de dejar tu pedido armado del todo me falta confirmarte el monto total. 🙏"*) antes de que salga
cualquier mensaje.

**Caso real, con la respuesta que casi se manda y la que se mandó de verdad**
(`flow-order-close-guard.test.js`, *"el modelo redacta un resumen que SUENA a cierre... NUNCA se le
manda ese texto al cliente"*):
- Cliente: *"dale, quiero 2, la agencia 1 me sirve. Carlos Perez, cedula 12345678, telefono
  04121234567"* (sin monto comunicado en ningún turno).
- El modelo (mockeado) redacta: *"Listo Carlos! Tu pedido de 2 Shilajit va a la agencia Tealca. El pago
  se hace contra entrega, y en cuanto tengamos la guía te aviso. ✅"* — un cierre con forma perfecta.
- El guard detecta que falta `total_comunicado` y reemplaza el mensaje. **Texto realmente enviado al
  cliente**: no contiene la frase original ("pedido de 2... agencia Tealca... contra entrega... guía te
  aviso"), sí contiene la palabra "falta" (verificado con `assert.match(enviado.text, /falta/i)`).
- **Estado final guardado**: `orderClosed` distinto de `true`, `stage` distinto de `'vendido'` — ambos
  resultados (lo que se dijo y lo que se guardó) son coherentes entre sí, que era tu objeción exacta.

### 1.8 Limitaciones que siguen sin resolverse (dichas explícitamente)

Sigue sin existir un **modelo de pedido estructurado** propio (`orderId`, campos validados uno por uno) —
identificado como cambio de arquitectura grande (hallazgo H08 en `docs/contratos.md`), fuera de alcance
de esta revisión. La validación sigue siendo heurística sobre texto, no sobre un objeto de pedido: cubre
los 6 casos que probaste, pero una frase nueva y distinta que ningún patrón de los de arriba reconozca
podría seguir sin cerrar sola (falso negativo — nunca cierra de más, por diseño). La lista de tokens
ambiguos (`si/ok/dale/listo/bueno/vale/bien/sip`) es fija; una palabra ambigua nueva que el negocio
detecte más adelante no está cubierta hasta que se agregue.

## 2. Prompts de producto y configuración del panel — separado del código, y con el bloqueo explícito

**Corrección de CÓDIGO (ya aplicada, en este repositorio, verificable en el diff):**

- `scrubUnverifiedResultClaims` (`src/ai.js`): filtro determinístico que se aplica a **toda** respuesta
  final del bot (venga del prompt núcleo, de un prompt de producto que yo no puedo ver, de la base de
  conocimiento, o de que el modelo lo haya improvisado). Saca la cláusula/oración que contenga:
  - "en los primeros días" + una palabra de efecto/resultado cerca ("energía", "resultados", "se siente", etc.)
  - "a medio camino" / "te deja a medias"
  - "resultados visibles desde el primer día"
  Si la respuesta ENTERA fuera la promesa (caso límite), se manda un mensaje de repuesto neutro en vez de
  la promesa o de un mensaje vacío. Se agregó también una línea explícita al prompt núcleo prohibiendo
  esto (`src/ai.js`, sección `COMO SE ARMA EL PEDIDO`).
- Reforzado también en el prompt núcleo: MRW/Zoom ya no se rechazan (ver informe v1, sección 2.2, sigue
  vigente).

**Corrección de CONFIGURACIÓN DEL PANEL (bloqueada, ver sección 0):** el texto real de cada prompt de
producto en `products.json` de producción, y cualquier "formulario automático" que puedas estar viendo
ahí, **no se tocó** porque no lo puedo leer. El filtro de código de arriba corta la frase textual si
aparece, pero el prompt de producto seguiría "sugiriéndosela" al modelo turno tras turno hasta que se
edite en origen — el filtro es una red de seguridad, no un reemplazo de corregir la fuente.

Sobre el "formulario automático" puntual: el código (`looksLikePendingFormPromise` en `flow.js`) ya
detecta la palabra "formulario" en cualquier variante y manda el pedido de datos real en su lugar (esto
ya estaba antes de esta revisión, ver v1 sección 1). Si en la configuración del panel hay una plantilla o
prompt de producto que dice textualmente "te paso el formulario automático" **y el negocio SÍ tiene un
formulario real** (a diferencia de lo que asumía la revisión original), decímelo: eso cambiaría qué hay
que corregir (no es lo mismo "no existe ningún formulario, hay que dejar de prometerlo" que "si existe un
formulario real, hay que agregarle el link real en vez de bloquearlo").

## 3. Pruebas completadas (con los casos que pediste explícitamente)

**[SIMULADO]** Igual que la sección 1: `flow.handleIncomingMessage` corre de verdad de punta a punta
(sesión real, persistencia real en disco, guard real), pero el texto que "el bot responde" en cada caso
de `flow-order-close-guard.test.js` es un texto fijo puesto por el test (`ai.getAssistantReply` mockeado
línea 42 de ese archivo) — no algo que el modelo haya redactado. "Integración end-to-end" acá significa
que el resto del sistema (sesión, guard, persistencia) es real; el texto de entrada al guard no lo es.

Suite completa: **227/227 tests OK** (verificado corriendo `node --test test/*.test.js` recién, no un
número recordado de una corrida anterior). Archivos nuevos/reescritos en esta ronda (v3):

- `test/ai-closing-message.test.js` (41 casos): las 7 señales por separado (incluye ahora presentación y
  total comunicado), el caso del cliente antiguo, `looksLikeAgencySelected`/`looksLikeDeliveryAddressGiven`
  como unidades, `looksLikeHoldOrRetraction`/`looksLikeContextualShortAcceptance`, `looksLikeTotalCommunicated`,
  `buildIncompleteOrderNotice`, y los formatos reales de teléfono/cédula ya cubiertos en v2 (`+58`,
  espacios, guiones, puntos). Incluye un test que documenta honestamente el único caso límite que sigue
  sin cubrir (dos números pegados con un solo espacio, sin palabra entre medio).
- `test/flow-order-close-guard.test.js` (9 casos, integración end-to-end contra
  `flow.handleIncomingMessage` real, no mocks aislados): cliente antiguo (2 sub-casos), cierre completo
  con formato de teléfono real, sticker solo, **domicilio con dirección real sin mencionar
  Tealca/agencia/guía** (sí cierra), **domicilio con solo la palabra "domicilio" sin dirección** (no
  cierra — caso nuevo de esta ronda), modificar cantidad de un pedido ya cerrado, y el guard de
  confirmación prematura (punto 6, caso nuevo de esta ronda: el bot nunca dice "confirmado" cuando el
  sistema no puede guardarlo así). Las secciones 1.2 a 1.7 de arriba citan los casos, las respuestas
  reales usadas y el estado final guardado de cada uno — no solo que el test existe.
- `test/remarketing-guards.test.js` (8 casos, sin cambios en esta ronda respecto a v2, ver sección 4).
- `test/ai-unverified-claims.test.js` (6 casos, sin cambios en esta ronda, ver sección 2).
- `test/ai-temperature.test.js` (2 casos, sin cambios).
- El resto de la suite (`catalog.test.js`, `orderGuard*.test.js`, `panel-*.test.js`, `state*.test.js`,
  etc.) no se tocó en esta ronda y sigue pasando sin modificaciones, lo que es la evidencia de
  compatibilidad hacia atrás pedida en el encargo original.

**Lo que sigue sin un test de regresión dedicado** (para no seguir prometiendo de más):

- "Quiero dos de resina, estoy en Valencia" como UN SOLO mensaje que trae dos datos juntos, reutilizando
  ambos sin volver a preguntarlos — el diseño del prompt lo contempla (ver `PRIORIDAD`, punto 1-3), y
  `looksLikeQuantityMentioned` reconoce "dos" + "de resina" fuera de una unidad exacta del catálogo
  también se cubre parcialmente, pero no hay un test end-to-end de ESTE mensaje puntual con dos datos
  mezclados en un solo string. Puedo agregarlo si querés, es rápido; no lo prioricé porque el mecanismo
  que lo resolvería (el prompt + el historial completo que ve el modelo) no cambió en esta revisión.
- Conversación histórica sin campos nuevos (dato que ya existía cubierto por `state-corrupt-sin-backup` y
  otros, pero no específicamente "una conversación vieja, de antes de esta revisión, sigue funcionando
  igual sin romperse por los campos nuevos que ahora chequea `evaluateOrderCompleteness`") — technically
  cubierto porque todos los campos que uso ya existían antes (`card.nombre/cedula/telefono/producto/ciudad/agencia`,
  el historial de mensajes); no agregué ningún campo nuevo a `sessions.json`, así que no hay migración
  posible de romper. Lo dejo anotado en la matriz como "cubierto por diseño, sin test dedicado".

## 4. Remarketing: demostrado, no solo descrito

`test/remarketing-guards.test.js` llama de verdad a `remarketing.revisarUnaVez()` (exportada para esto)
contra sesiones fabricadas, con el envío real mockeado para poder contar cuántos mensajes se mandaron.
8 casos:

1. Caso de control: una conversación colgada de verdad (6 horas sin novedad, sin ningún guardrail) SÍ
   recibe el recordatorio — confirma que el mecanismo de base funciona antes de probar los bloqueos.
2. **`orderClosed: true` bloquea el envío aunque la ETAPA no esté en `SOLD_STAGES`** (caso real: un
   operador fija la etapa a mano a "necesita_atencion" para escalar un reclamo DESPUÉS de que el pedido
   ya se había cerrado por texto). Esto era un hueco real que encontré al escribir el test: antes de este
   cambio, `remarketing.js` solo miraba `SOLD_STAGES`, nunca el flag `orderClosed` directamente.
3. Una etapa de `SOLD_STAGES` (`entregado`) también bloquea, como ya hacía antes.
4. Rechazo explícito (`perdido`) bloquea, como ya hacía antes.
5. **`escribir_mas_tarde` ahora también bloquea** (antes NO lo hacía: era otro hueco real que encontré.
   Un cliente que dice "te escribo la semana que viene" quedaba tratado igual que cualquier lead sin
   cerrar, y sí recibía el recordatorio de "todavía no compraste" a las 2h/5h, contradiciendo lo que el
   mismo cliente pidió).
6. Conversación pausada (un humano la tomó) bloquea, como ya hacía antes.
7. Cada paso (2h, 5h) se manda como mucho una vez: correr `revisarUnaVez()` dos veces seguidas no duplica
   el envío (el flag `remarketingSentAt5h` lo evita).
8. Conversaciones colgadas desde ANTES de activar remarketing nunca reciben nada, aunque sigan colgadas
   para siempre.

Los puntos 2 y 5 son correcciones de código reales de esta revisión (`src/remarketing.js`), no solo
pruebas de algo que ya existía.

## 5. Matriz requisito → código/config → prueba → resultado → limitación

**[SIMULADO]** Todas las filas de esta matriz están probadas con texto de bot escrito a mano en el test
correspondiente (código real, entrada de texto simulada) — la única fila marcada por separado como
**[MODELO REAL]** (evaluación con prompts reales, al final de la tabla) es la única que, una vez
ejecutada, citará una respuesta efectivamente generada por OpenAI.

| Requisito (tu pedido) | Código/config que lo resuelve | Prueba | Resultado | Limitación honesta |
|---|---|---|---|---|
| Ciudad conocida NO equivale a destino resuelto (punto 1) | `destinoYaResuelto` en `evaluateOrderCompleteness`, exige `cardAgencia`/`looksLikeAgencySelected`/`looksLikeDeliveryAddressGiven` (`ai.js`) | `ai-closing-message.test.js` ("destino NO resuelto solo con knownCity", "destino resuelto con agencia puntual", "destino resuelto con direccion real"); `flow-order-close-guard.test.js` (domicilio con/sin dirección real, 2 casos e2e) | ✅ 227/227 | Heurística de texto (patrones de dirección/agencia), no una dirección validada contra un mapa o base de zonas reales |
| Un mensaje que no sea sí/ok/sticker no equivale a aceptar (punto 2) | `looksLikeHoldOrRetraction`, `PURE_PRICE_QUESTION_RE`, `looksLikeContextualShortAcceptance` (`ai.js`) | `ai-closing-message.test.js`: "¿cuánto cuestan dos?", "no me lo envíes todavía" (bloquea con datos completos), "antes quería dos, ahora solo consultando", aceptación contextual válida y su contraparte donde el rechazo gana | ✅ | Lista de tokens ambiguos fija (`si/ok/dale/listo/bueno/vale/bien/sip`); frase de rechazo/aceptación nueva y distinta de los patrones cubiertos podría no reconocerse hasta agregarla |
| Cierre de delivery sin "Tealca"/"agencia"/"guía" (punto 3) | `looksLikeClosingSummaryText` estructural (pago + recap/seguimiento), ya no depende de esas 3 palabras | `flow-order-close-guard.test.js`, caso e2e con texto verificado en el propio test que no usa esas 3 palabras | ✅ cierra igual (`orderClosed:true`, `stage:'vendido'`) | — |
| Presentación y total comunicado y aceptado, no solo producto+cantidad (punto 4) | `looksLikePresentationConfirmed`, `looksLikeTotalCommunicated` (`ai.js`) | `ai-closing-message.test.js`: ambigüedad de presentación con catálogo de 2 variantes, "falta solo el total comunicado" | ✅ | Presentación solo se exige distinguir cuando el catálogo realmente tiene variantes activas del mismo nombre base; total exige un monto en Bs en el texto de cierre, no una verificación campo por campo contra el catálogo |
| Conservar datos del pedido actual fuera de la ventana reciente, sin reutilizar datos de un pedido anterior (punto 5) | `flow.js`: ventana acotada por el último cierre real en el historial (`cierreAnteriorIdx`), no un conteo fijo de mensajes | Ejercitado indirectamente por los casos de "CLIENTE ANTIGUO" (sin cierre previo en el historial de prueba) | ✅ diseño coherente con el objetivo | Sin un test dedicado que arme un historial largo con un cierre real en medio y verifique explícitamente el corte — anotado como pendiente, no como resuelto con test propio |
| El bot no dice "pedido confirmado" cuando la validación no permite guardarlo así (punto 6) | Guard en `flow.js`, corre antes de `sendReply`, reemplaza `finalReply` por `buildIncompleteOrderNotice` | `flow-order-close-guard.test.js`, caso "el modelo redacta un resumen que SUENA a cierre..." — verifica el texto realmente enviado Y el estado guardado | ✅ ambos resultados coherentes | El aviso de reemplazo es genérico (lista de qué falta), no reescribe el resto de la respuesta del modelo que pudiera acompañar al cierre |
| **[MODELO REAL]** Evaluación con los prompts reales del negocio, verifica pedidos incompletos nunca confirmados Y pedidos válidos completos sin repetir preguntas (punto 7) | `eval/model-eval.js` + `eval/real-products.local.json` (harness reescrito esta ronda, corre por `flow.handleIncomingMessage` real, ver sección 6) | 8 escenarios (conversación larga, cambio de cantidad, delivery, cliente antiguo, aceptación de total). Mecánica del harness verificada con respuestas de prueba fijas (no el modelo real, ver 6.1) | ⏸️ **Todavía no ejecutado contra el modelo real**: sin `OPENAI_API_KEY`, y sin tus prompts reales | El harness en sí puede tener falsos positivos/negativos si el modelo real redacta algo fuera de los patrones que anticipé al escribir los escenarios |
| Parche/archivos completos para revisión independiente (punto 8) | Diff generado, ver sección 7 | — | ✅ entregado en este mensaje | — |
| Separar seguimientos del cambio de cierre en commits publicables por separado (punto 9) | Historial reescrito localmente: `750b851` (remarketing), `6e8d51d`+`d1b7b3d` (validación de cierre v2+v3), `466ac37`+`318cbf7` (harness de evaluación) | — | ✅ 3 líneas de trabajo, cada una revisable/desplegable sola | El commit de validación de cierre quedó en 2 partes (v2 base + v3 sobre esa base) en vez de una sola, porque v3 corrige a v2 — se pueden revisar juntas como una unidad si preferís aplastarlas antes de desplegar |
| Cliente antiguo con datos guardados no cierra por cobertura | `evaluateOrderCompleteness` exige producto+cantidad+destino+aceptación+total, no solo identidad | `flow-order-close-guard.test.js`, caso "CLIENTE ANTIGUO" | ✅ | — |
| MRW/Zoom disponibles con pago anticipado, sin rechazarlos | Prompt núcleo (`ai.js`, sección MEDIOS DE PAGO), sin cambios en esta ronda | `ai-closing-message.test.js` (contenido del prompt) | ✅ a nivel prompt. **No verificado contra el modelo real** (ver sección 6) | No hay integración real con un proceso de pago anticipado: se deriva a humano |
| No Cashea, no dólares, no promociones inventadas | Prompt núcleo (sección MEDIOS DE PAGO) | `ai-closing-message.test.js` | ✅ a nivel prompt. No verificado contra el modelo real | — |
| No prometer "en los primeros días" / "a medio camino" | `scrubUnverifiedResultClaims` (código), sin cambios en esta ronda | `ai-unverified-claims.test.js` (6 casos) | ✅ como red de seguridad de código | **La fuente real (prompt de producto en el panel) sigue sin poder editarse — bloqueo de acceso, sección 0** |
| "Formulario automático" no prometido si no existe | `looksLikePendingFormPromise` (ya existía) | Cubierto por la suite preexistente | ✅ si el formulario de verdad no existe | **No confirmado si el negocio tiene o no un formulario real — pregunta pendiente, sección 0** |
| Seguimientos respetan orderClosed / pausas / rechazo / fechas futuras acordadas | `remarketing.js`, sin cambios en esta ronda | `remarketing-guards.test.js` | ✅ | Ver limitación de v2: no hay campo con la fecha EXACTA prometida |
| No duplicar pedidos/notificaciones al modificar cantidad de un pedido cerrado | `flow.js` (gate `!orderClosed`) | `flow-order-close-guard.test.js`, caso "modificar cantidad" | ✅ | — |
| Temperatura 0.2 sin tocar modelo/top_p | `settings.openaiTemperature` (ya existía) | `ai-temperature.test.js` | ✅ | — |

## 6. Evaluación con el modelo real — harness reescrito para los 2 resultados que pediste, sigue bloqueada por 2 insumos

Reescribí `eval/model-eval.js` (todavía sin ejecutarse contra el modelo real: mismo bloqueo, sin
`OPENAI_API_KEY` y sin tus prompts reales) para que deje de ser una lista de textos sueltos con checks de
regex y pase a comprobar exactamente los **2 resultados** que pediste:

1. **Un pedido incompleto nunca queda confirmado.** En cada uno de los 8 escenarios, y en cada turno de
   cada uno, se revisa: si el texto que `flow.js` REALMENTE manda al cliente (después del guard, nunca el
   texto crudo del modelo) tiene forma de cierre (`ai.looksLikeClosingSummaryText`), la sesión tiene que
   haber quedado con `orderClosed: true` en ese mismo turno — si no, es una falla. Este chequeo corre
   siempre, no solo en los casos "pensados para fallar".
2. **Un pedido válido sí se completa, sin repetir preguntas de datos ya dados.** Cada escenario declara si
   al final tiene que quedar cerrado (`debeCerrar`), y se verifica el estado final de la sesión. Además,
   una vez que la identidad (nombre+cédula+teléfono) ya está confirmada, se revisa que ningún mensaje
   posterior vuelva a pedirla (patrón `PIDE_IDENTIDAD_RE`), y lo mismo para cantidad/destino en los
   escenarios donde aplica.

### 6.1 Los 8 escenarios (correo por `flow.handleIncomingMessage` real, no por `ai.getAssistantReply` aislado)

A diferencia de la v2 (8 mensajes sueltos contra `ai.getAssistantReply`), ahora cada escenario es una
**conversación de varios turnos** que pasa por el mismo punto de entrada que usa el webhook real, con el
modelo real Y el clasificador real (`classifyConversation`) corriendo sin mockear — solo se mockea el
envío (`whatsapp.js`) y la notificación push, igual que en los tests de integración:

1. Conversación larga con un desvío en el medio (pregunta si envían a otros países) y cierre de delivery
   al final — cubre "conversaciones largas" y "delivery".
2. Cliente antiguo (datos ya guardados) que solo pregunta cobertura — no debe cerrar.
3. Cliente antiguo que sí arma un pedido nuevo real (agencia puntual + aceptación) sin repetir sus datos
   — cubre "clientes antiguos".
4. Cambio de cantidad antes de cerrar (pide 2, se arrepiente, pide 4) — cubre "cambios de cantidad".
5. Delivery a domicilio cuyo cierre no tiene por qué mencionar Tealca/agencia/guía.
6. Pregunta de precio + retractación explícita, ninguna de las dos cierra; el pedido real después sí —
   cubre "aceptación del total" junto con el resto de datos.
7. Sticker solo, con casi todo lo demás ya en la ficha, no alcanza para cerrar.
8. Pedido ya cerrado: cambiar la cantidad después no reabre ni duplica el aviso de venta.

**Verificación de que el harness en sí funciona (hecha esta ronda, sin gastar nada de tu presupuesto):**
corrí una copia del script con `ai.getAssistantReply` y `classifyConversation` reemplazados por
respuestas de prueba fijas (nunca el modelo real) para confirmar que la mecánica no tiene bugs: el
polling de espera por el envío asíncrono, la lectura de sesión después de cada turno, el chequeo de
coherencia, el chequeo de "no repetir preguntas", y el resumen PASS/FAIL con código de salida, todos
corrieron sin errores en los 3 escenarios que probé así (1, 7 y 8). **Esto NO es una corrida real ni
reemplaza la evaluación con el modelo** — es la verificación de que, cuando la corra de verdad, el script
no se va a caer por un bug propio ni va a reportar mal el resultado por un error de programación mío.

- Si existe el archivo `eval/real-products.local.json` (nunca commiteado — está en `.gitignore`), el
  script carga ESE catálogo como los productos de la corrida, en vez del producto genérico de prueba
  (`Shilajit Eval`). Si no existe, o no se puede parsear, cae de vuelta al producto de prueba genérico y
  lo dice por consola — nunca falla en silencio ni finge que usó datos reales cuando no los tuvo.
- Seguís siendo vos quien pega ese archivo (o yo lo creo con el texto que me pegues acá) directamente en
  este entorno aislado — nunca toca `products.json` real de producción, nunca se commitea, y el script
  sigue sin importar `whatsapp.js` ni ningún código de envío, así que es imposible que mande algo a un
  cliente real.
- **Todavía no me pasaste el texto real de tus prompts de producto**, así que hoy la corrida (si tuviera
  la API key) seguiría usando el producto genérico. Esto está anotado en la sección 0 como bloqueo (a).
- **Nunca voy a poner una credencial en el chat ni en un archivo del repo** (ni siquiera en
  `real-products.local.json`, que es solo para el texto de los prompts, nunca para secretos): la única
  forma en que este script recibe la key es como variable de entorno al momento de ejecutarlo
  (`OPENAI_API_KEY=sk-... node eval/model-eval.js`), que no queda en ningún archivo ni en el historial de
  git.

**Modelo efectivo, límite de llamadas y tokens, y presupuesto (tal como pediste, sin garantizar un
máximo que no calculé) — actualizado porque el harness ahora es de conversaciones de varios turnos, no de
mensajes sueltos:**
- Modelo efectivo: `gpt-4o-mini`, tomado del default en `src/ai.js` (`settings.openaiModel` o
  `OPENAI_MODEL` si se fija esa variable) — si tu configuración de producción usa otro modelo, decímelo
  porque el costo cambia con eso. El script imprime el modelo efectivo al arrancar.
- Límite de llamadas: los 8 escenarios suman **20 turnos en total** (5+1+3+4+2+3+1+1). Cada turno dispara
  hasta **2 llamadas reales**: la respuesta (`ai.getAssistantReply`) y, después de mandarla, la
  reclasificación de etapa/ficha (`classifyConversation`, que corre siempre que la etapa no esté fijada a
  mano — ninguno de los 8 escenarios la fija). Tope real: **hasta 40 llamadas**, no reintenta en caso de
  error de red.
- Límite de tokens por llamada: no hay un `max_tokens` explícito puesto en el script — usa el que ya usa
  `ai.getAssistantReply`/`classifyConversation` en producción (no los cambié). El prompt de sistema crece
  con el catálogo real que pegues; con el producto de prueba genérico ronda unos pocos miles de
  caracteres.
- Presupuesto estimado: con `gpt-4o-mini` y sus precios públicos actuales (del orden de centavos de dólar
  por millón de tokens), 40 llamadas de este tamaño deberían seguir costando una fracción de centavo a
  unos pocos centavos de dólar — no dólares enteros. **No calculé esto con una cifra exacta de tokens
  reales (dependen del tamaño final de tu catálogo/prompts, que todavía no tengo), así que no te doy un
  número cerrado ni te garantizo un tope máximo**: si tu catálogo real es mucho más grande, el costo por
  llamada sube proporcionalmente, y te paso el número real de la corrida en cuanto la haga.

**Sobre "usaré una credencial de prueba mediante configuración segura, no pegada en el chat"**: dejo esto
marcado explícitamente en la sección 0(b) porque hoy no existe ningún canal de configuración segura
conectado a este entorno aislado — necesito que me confirmes cómo pensás pasarla (la forma más simple es
como variable de entorno al momento de correr el comando, `OPENAI_API_KEY=sk-... node eval/model-eval.js`,
que nunca queda en el chat ni en el historial de git) antes de asumir un mecanismo por mi cuenta.

En cuanto tenga ambos insumos (prompts reales + la key por el canal que confirmes), corro el script y te
paso el resultado PASS/FAIL de cada caso con la respuesta real del modelo incluida, antes de cualquier
otra cosa — nunca marco esto como resuelto solo por tener el script escrito.

## 7. Diff completo para revisión independiente

Todo el trabajo está en la rama `audit-cierre-flexible-20260918`, sobre `main` (`86d5731`), en 10 commits
locales, **ninguno pusheado, mergeado ni desplegado**:

```
06e3fb3  Corrige falso cierre de pedido y contradiccion MRW/Zoom en el prompt
06f29a7  Documenta la revision de cierre flexible / MRW-Zoom (informe completo)
750b851  Remarketing: bloquea recordatorios cuando orderClosed, perdido o escribir_mas_tarde
6e8d51d  Valida pedido completo (no solo identidad) y filtra promesas no sostenibles
466ac37  Agrega harness de evaluacion con el modelo real (no ejecutado, sin API key)
453daf2  Actualiza informe a v2: valida pedido completo, separa panel de codigo
d1b7b3d  Validacion de cierre v3: destino real, aceptacion en contexto, total, presentacion
318cbf7  Harness de evaluacion: soporte para catalogo real via eval/real-products.local.json
c624b9b  Actualiza informe a v3: valida los 6 casos del tercer mensaje con evidencia
5a1e051  Harness de evaluacion: verifica los 2 resultados pedidos, no solo texto suelto
```

Los primeros 6 son el trabajo de v1/v2, separados en commits independientes según el punto 9 (antes
mezclados en `ab8fb03`, ya no existe en esta rama — reescritura local, nada compartido tocado). `d1b7b3d`
es la validación de cierre v3 (puntos 1 a 6 de tu tercer mensaje). `318cbf7` y `5a1e051` son las dos
mitades del harness de evaluación (soporte de catálogo real, y esta ronda: el harness de escenarios
multi-turno que verifica los 2 resultados que pediste). `c624b9b` y este mismo commit del informe son
documentación, sin cambios de código.

**Patch adjunto a este mensaje** con el diff completo desde el informe v2 (`git diff 453daf2..HEAD`):
cubre `d1b7b3d`, `318cbf7`, `c624b9b` y `5a1e051` en un solo archivo, para revisar el estado actual sin
clonar la rama. Para el diff contra `main` completo (las 3 líneas de trabajo juntas):
`git diff 86d5731 HEAD`.

Archivos de código modificados en `d1b7b3d` (validación de cierre v3):
- `src/ai.js`: `normalizeForMatch`, `looksLikeAgencySelected`, `looksLikeDeliveryAddressGiven`,
  `looksLikeHoldOrRetraction`, `looksLikeContextualShortAcceptance`, `looksLikePresentationConfirmed`,
  `looksLikeTotalCommunicated`, `looksLikeClosingSummaryText` (reescrito, ya no depende de
  tealca/pago/guía como keywords), `buildIncompleteOrderNotice`, `evaluateOrderCompleteness` (reescrito,
  7 señales), fix en `looksLikeQuantityMentioned` (no confundir "agencia 1" con cantidad 1).
- `src/flow.js`: ventana de pedido actual acotada por el último cierre real (`cierreAnteriorIdx`), guard
  de confirmación prematura antes de `sendReply` (punto 6).
- `test/ai-closing-message.test.js`, `test/flow-order-close-guard.test.js`: reescritos con los casos de
  los 6 puntos (ver sección 1 y 3).

Archivos modificados en `318cbf7` (harness de evaluación, catálogo real):
- `eval/model-eval.js`: carga `eval/real-products.local.json` si existe.
- `.gitignore`: agrega `eval/real-products.local.json`.

Archivo modificado en `5a1e051` (harness de evaluación, escenarios multi-turno):
- `eval/model-eval.js`: reescrito por completo — corre por `flow.handleIncomingMessage` real (no
  `ai.getAssistantReply` aislado), 8 escenarios de conversación de varios turnos, chequeo de coherencia
  (nada se confirma sin estar completo) y de no repetición de preguntas. Ningún otro archivo de código
  cambia en este commit.

## 8. Procedimiento de despliegue y reversión — revisado para v3, sigue vigente

Vuelvo a confirmar lo dicho en v1/v2, ahora con los commits de v3 incluidos: **volver al código anterior
no deshace los mensajes que el bot ya mandó ni los cambios de estado que ya se guardaron mientras el
código nuevo estuvo activo.** Si después de desplegar esto algún pedido se cerró (o NO se cerró) de una
forma que no correspondía, revertir `src/ai.js`/`src/flow.js`/`src/remarketing.js` a la versión de
`86d5731` (el commit de `main` antes de toda esta revisión) detiene el comportamiento NUEVO hacia
adelante, pero:

- Los mensajes de WhatsApp que ya se mandaron durante el tiempo que estuvo desplegado siguen mandados;
  no hay forma de "retirarlos" del chat del cliente.
- Las conversaciones que quedaron con `orderClosed`/`stage: 'vendido'`/`soldAt` guardados durante ese
  período (correcta o incorrectamente) siguen así en `sessions.json`: revertir el código no reescribe
  datos ya persistidos. Si algún pedido quedó mal marcado (cerrado quando no debía, o sin cerrar cuando
  sí correspondía), hay que corregirlo A MANO desde el panel (`setStage`/`unlockStage`, ya existentes),
  conversación por conversación — no hay ningún botón de "deshacer" automático.
- Las conversaciones a las que el remarketing NO les mandó nada durante ese período (por los nuevos
  chequeos de `orderClosed`/`escribir_mas_tarde`) tampoco se "recuperan" solas: si alguna de esas SÍ
  necesitaba el recordatorio, revertir el código no se lo manda retroactivamente.

Por eso, antes de desplegar esto en producción de verdad, recomiendo:
1. Desplegarlo primero mirando de cerca las primeras conversaciones reales que toquen el camino de cierre
   (unas horas, no días), en vez de "desplegar y olvidarse".
2. Tener a mano `setStage`/`unlockStage` del panel para corregir a mano cualquier caso que la nueva
   validación deje sin cerrar cuando sí correspondía (el trade-off deliberado de la sección 1.4: prefiere
   fallar por defecto, no cerrar de más).

El procedimiento de subida en sí no cambió respecto a la v1: subir `src/ai.js`, `src/flow.js` y
`src/remarketing.js` por la interfaz web de GitHub y "Manual Deploy → Deploy latest commit" en Render, sin
ninguna variable de entorno nueva ni migración de `settings.json`/`sessions.json`.
