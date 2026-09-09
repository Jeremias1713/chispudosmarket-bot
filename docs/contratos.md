 pedido, mensaje y estados (Fase 0)

Este documento fija el vocabulario y las formas de datos que van a usar las
fases 1–9 del plan de reparación (basado en la auditoría del 8/9/2026,
hallazgos H01–H41). Es un contrato de **diseño**, no una migración: nada de
esto se implementa todavía. Sirve para que cada fase futura hable el mismo
idioma sin tener que releer toda la auditoría.

## 1. Estado actual (línea base, ya en el código)

- Una sesión = una conversación = un teléfono (`src/state.js`, `sessions.json`).
- Cada sesión tiene **una sola** `card` (ficha: nombre, ciudad, teléfono,
  cédula, producto, notas) y **una sola** `stage` (etapa).
- `SOLD_STAGES` (`src/flow.js`): `vendido`, `esperando_guia`,
  `esperando_retiro`, `en_camino`, `entregado`. Estas son las etapas que
  cuentan como "pedido cerrado" hoy.
- `stageLocked` congela la etapa contra el clasificador automático.
- No existe `orderId` ni lista de pedidos: dos compras del mismo cliente
  comparten la misma `card` y se pisan entre sí (H08).
- No existe registro de mensajes salientes con estado de entrega de Meta
  (H06): solo se sabe que la API aceptó la petición HTTP.

Esta es la causa raíz que las Fases 2 y 3 van a resolver. El contrato de
abajo es la forma objetivo; se migra de forma aditiva (sin borrar `card` ni
inventar historial que no existe).

## 2. Contrato de Pedido (`Order`) — objetivo Fase 3

```
Order {
  orderId: string            // nuevo identificador estable, generado al cerrar
  phone: string              // telefono normalizado (E.164 o formato interno consistente)
  guiaId: string | null      // numero de guia de envio, si existe
  producto: string | null
  monto: { valor: number, moneda: string } | null   // NUNCA "0" como sinonimo de "desconocido"
  agencia: string | null     // nombre real de agencia, no la ciudad
  stage: OrderStage          // ver seccion 4 (NO reusar `session.stage` a ciegas)
  soldAt: string | null      // ISO 8601, solo si hay evidencia real de venta
  shippingNotifiedAt: string | null  // solo cuando el aviso fue confirmado, no al guardar la guia
  createdAt: string
  updatedAt: string
}
```

Reglas:

- `session.card` pasa a ser una **vista de compatibilidad** del pedido activo
  (el más reciente sin cerrar/entregar), no la fuente de verdad. Código
  viejo que lea `session.card` sigue funcionando durante la migración.
- Dos guías distintas para el mismo teléfono en una misma importación
  (H08/H33) exigen revisión manual, nunca sobrescritura silenciosa.
- `monto` es un objeto tipado, no un string con "bs" pegado (eso es solo
  presentación al armar la plantilla — ver H12). Un valor vacío en el Excel
  es `null`, nunca `0`.

## 3. Contrato de Mensaje saliente (`OutboundMessage`) — objetivo Fase 2

```
OutboundMessage {
  localId: string       // clave propia, generada ANTES de llamar a Meta (permite deduplicar aunque falle el POST)
  wamid: string | null   // ID que devuelve Meta; null hasta tener respuesta
  phone: string
  orderId: string | null // referencia al pedido si aplica (guia, aviso de envio, etc.)
  kind: 'template' | 'freeform' | 'image' | 'audio'
  templateName: string | null
  contentSnapshot: object // que se mando realmente (variables ya resueltas), no solo el nombre de plantilla
  status: 'queued' | 'sent_to_meta' | 'accepted' | 'delivered' | 'read' | 'failed' | 'unknown_timeout'
  error: string | null
  createdAt: string
  updatedAt: string
}
```

Reglas clave (de H06/H09/H14):

- `accepted` (Meta recibió el HTTP 200) **no** es `delivered`. El panel no
  debe mostrar "enviado ✓" hasta tener el estado real por webhook.
- Los webhooks de `statuses` pueden llegar fuera de orden o duplicados: un
  estado nunca retrocede (ej. `read` no puede ser pisado por un `sent`
  tardío), y un mismo `wamid` no genera dos entradas.
- Un timeout de red es `unknown_timeout`, no `failed`: no se reintenta como
  si se supiera con certeza que nunca salió.
- Idempotencia: clave única por `orderId + kind` (o `phone + kind` cuando no
  hay pedido) para evitar el doble envío de H09/H33.

## 4. Estados logísticos (`OrderStage`) — objetivo Fase 6

Tabla de transición explícita, en vez de dejar que cualquier clasificación
de IA mueva la etapa libremente (H10):

```
nuevo → interesado → negociando → vendido
                                     ↓
                              esperando_guia
                                     ↓
                             esperando_retiro
                                     ↓
                               en_camino
                                     ↓
                               entregado
```

Reglas:

- Solo evidencia de transportista/operador (Excel de Dropanas, acción
  manual del panel) puede mover `esperando_retiro → en_camino → entregado`.
  El texto que el bot le manda al cliente ("ya está en camino") **no** es
  evidencia de que ocurrió.
- `escribir_mas_tarde` es una rama lateral desde cualquier etapa pre-venta,
  no un estado logístico.
- Una clasificación nueva de la IA nunca puede mover una sesión hacia atrás
  dentro de `SOLD_STAGES` (esto ya existe parcialmente en `flow.js` vía
  `SOLD_STAGES.includes(session.stage)`, pero H10 señala que el propio
  clasificador describe mal `esperando_retiro`/`en_camino`, así que hay que
  corregir también las definiciones que ve el modelo, no solo el guardado).
- `stageLocked` sigue siendo la única forma de congelar manualmente; ninguna
  automatización nueva debe poder pisarlo.

## 5. Cómo usar esto en las fases siguientes

- Fase 2 implementa `OutboundMessage` y el manejo de `statuses` del webhook.
- Fase 3 implementa `Order` (aditivo, con `card` como vista de compatibilidad)
  y el cruce seguro por `orderId`/guía/teléfono.
- Fase 6 implementa la tabla de transición de `OrderStage` y separa
  intención comercial de estado logístico en el clasificador.
- Cualquier fase que necesite un campo no listado aquí debe agregarlo a este
  documento en el mismo commit que lo introduce, no inventarlo suelto en el
  código.
