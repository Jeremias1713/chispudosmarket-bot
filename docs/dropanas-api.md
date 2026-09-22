# Integración oficial con Dropanas

El monitoreo de pedidos (`dropanasMonitor.js`/`dropanasAuto.js`) es de solo lectura: solo hace `GET` contra la URL oficial, rechaza otra URL base, y nunca crea, modifica ni elimina pedidos.

Aparte de eso existe un módulo separado, `dropanasOrderAutomation.js`, que SÍ puede crear pedidos nuevos en Dropanas (POST `/ordenes`) a partir de una venta ya cerrada en el bot — ver "Creación automática de pedidos" más abajo. Está apagado por defecto y exige un token de producción (`live`); todo pedido creado así queda igual pendiente de aprobación en Dropanas, nunca se auto-aprueba.

## Qué ya hace (monitoreo, solo lectura)

- Lee todas las páginas de `/ordenes` y `/novedades` (100 registros por página).
- Comprueba que el modo devuelto por Dropanas coincida con el tipo de token (`live` o `sandbox`).
- Crea una línea base en la primera consulta: los pedidos antiguos no generan avisos.
- Detecta después pedidos nuevos y cambios relevantes, sin duplicarlos.
- Cruza primero por teléfono exacto y conserva como revisión manual los casos ambiguos.
- Propone guías y cambios de seguimiento en el panel antes de enviar mensajes.
- Descarga la etiqueta oficial desde `GET /ordenes/{id}/guia.pdf`, comprueba
  que contenga la guía esperada y la convierte en PNG para WhatsApp.
- Permite probar esa plantilla completa en el número del negocio sin tocar la
  conversación del cliente.
- Incluye un modo de envío completamente automático, apagado por defecto, que
  solo acepta coincidencias únicas por teléfono. Los cruces por nombre nunca
  se envían solos.
- Mantiene pendientes los avisos que WhatsApp no aceptó, para permitir reintentos.
- Acepta webhooks firmados. Para `order.guide_generated` consulta únicamente
  `GET /ordenes/{id}` y luego descarga el PDF oficial; no depende del listado
  `/ordenes`, no abre el panel web y no toma capturas.

## Activación segura

1. Rote el token de producción que fue compartido por chat. No debe reutilizarse como secreto permanente.
2. En Render, copie las variables de `.env.dropanas.example`.
3. Cargue el token nuevo en `DROPANAS_API_TOKEN`.
4. Active `DROPANAS_API_ENABLED=true` y `DROPANAS_API_READ_ONLY_ACK=true`.
5. Deje `DROPANAS_API_POLL_ENABLED=false` al principio.
6. Active `DROPANAS_GUIDE_ENABLED=true`. La etiqueta usa el mismo
   `DROPANAS_API_TOKEN`; ya no necesita credenciales del panel web.
7. Abra el panel y pulse **Consultar API (solo lectura)**. La primera consulta
   debe indicar que creó la línea base y debe proponer cero avisos.
8. Después de que aparezca una guía Tealca nueva, use **Probar** para enviarla
   primero al número del negocio. El panel descarga la etiqueta original; no
   hace falta subir una captura manual.
9. Confirme una sola fila real desde el panel y verifique imagen, variables y
   entrega en WhatsApp.
10. Mantenga `DROPANAS_API_POLL_ENABLED=false` si usará el webhook. El sondeo
    completo queda solo como respaldo manual.
11. Solo después de esas pruebas, active `DROPANAS_AUTO_SEND_ENABLED=true`.
    El modo automático no procesa transportistas sin descarga implementada ni
    coincidencias ambiguas; quedan pendientes en el panel.

## Webhook

Registre en Dropanas esta URL pública:

`https://chispudosmarket-bot.onrender.com/dropanas/webhook`

Guarde el secreto entregado por Dropanas en `DROPANAS_WEBHOOK_SECRET`. El servidor exige firma HMAC-SHA256, timestamp reciente y un identificador de entrega. Responde rápido y después ejecuta una lectura oficial GET.

## Qué falta fuera del código

- El dominio público real del despliegue, para registrar el webhook.
- Los nombres e idiomas exactos de las plantillas aprobadas en Meta/WhatsApp.
- Un token de producción nuevo después de rotar el que se expuso en la conversación.
- Una cuenta web dedicada de Dropanas. El inicio de sesión del navegador del
  dueño no se puede ni se debe copiar a Render: el servidor inicia su propia
  sesión con secretos de entorno.
- Un disco persistente en Render, si se quiere conservar las imágenes y el
  estado entre despliegues/reinicios. Sin disco, una etiqueta ya enviada no se
  pierde de WhatsApp, pero el archivo local y la línea base pueden desaparecer.

La descarga integrada es deliberadamente específica para etiquetas Tealca,
porque es la ruta real verificada. Otros transportistas quedan en revisión
manual hasta implementar y validar su documento original.

## Estado y recuperación

El estado se guarda en `data/dropanas-api-state.json`, que está ignorado por Git. Si el archivo desaparece, la siguiente consulta vuelve a crear una línea base y no genera avisos retroactivos. El endpoint `/health` expone únicamente estado seguro, nunca el token.

## Creación automática de pedidos (`dropanasOrderAutomation.js`)

Distinto del monitoreo de arriba: este módulo puede crear pedidos NUEVOS en Dropanas a partir de una venta que el bot ya cerró. Se activa en el panel, en "Subir pedidos" (`dropanasOrderUploadEnabled`/`dropanasOrderAutoCreateEnabled`), y exige token de producción (`live`) — nunca funciona contra el token de pruebas. Todo pedido creado así llega a Dropanas con `requiere_aprobacion: true`, es decir, sigue necesitando aprobación manual ahí antes de generar guía; "automático" acá quiere decir "se sube solo", nunca "se aprueba solo".

Para que un producto pueda subirse así, tiene que resolver a un producto real de Dropanas (su `productId` y `bodega`). Hay dos formas de cargar esa relación, y se pueden mezclar:

- **Desde el catálogo de productos de siempre** (recomendado): al editar un producto normal del catálogo (el mismo que usa la IA para vender), cargar su "ID producto en DroPanas" y su "Bodega DroPanas". Con eso alcanza — no hace falta repetirlo en ningún otro lado, y si se cambia el precio en el catálogo, se refleja solo acá.
- **Tabla de mapeo manual** (pantalla "Subir pedidos" del panel): pensada para casos que no calzan uno a uno con el catálogo (alias distintos, precios por cantidad diferentes a los del catálogo, etc.). Si un mismo `productId` de Dropanas está cargado en las dos formas a la vez, la tabla manual gana.

Un producto sin ninguna de las dos cargas queda bloqueado ("no tiene un mapeo único a DroPanas") en la cola de pedidos del panel, con el motivo a la vista.
