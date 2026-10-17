/* Fase 7: panel de "bajar devoluciones". Archivo aparte para no tocar app.js.
   Todo se pinta con textContent (nada de innerHTML con datos del cliente). */
(function () {
  'use strict'
  var API = '/panel/api'

  function call(path, options) {
    return fetch(API + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options)).then(function (res) {
      if (res.status === 401) { window.location.href = '/panel/login'; throw new Error('Sesion vencida') }
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || res.statusText)
        return body
      })
    })
  }

  function el(tag, props, children) {
    var node = document.createElement(tag)
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'class') node.className = props[k]
      else if (k === 'text') node.textContent = props[k]
      else if (k === 'on') Object.keys(props.on).forEach(function (ev) { node.addEventListener(ev, props.on[ev]) })
      else node.setAttribute(k, props[k])
    })
    ;(children || []).forEach(function (c) { if (c) node.appendChild(c) })
    return node
  }

  function field(label, input, help) {
    return el('div', { class: 'field' }, [el('label', { text: label }), help ? el('div', { class: 'help', text: help }) : null, input])
  }
  function check(id, label, help) {
    return el('div', { class: 'field' }, [
      el('label', { class: 'switch' }, [el('input', { type: 'checkbox', id: id }), el('span', { text: label })]),
      help ? el('div', { class: 'help', text: help }) : null,
    ])
  }
  function num(id, ph) { return el('input', { type: 'number', id: id, placeholder: ph || '' }) }
  function txt(id, ph) { return el('input', { type: 'text', id: id, placeholder: ph || '' }) }
  function $(id) { return document.getElementById(id) }

  function buildConfigCard() {
    if ($('f7_card')) return
    // Va como tarjeta propia de Configuracion. Antes se metia antes del primer
    // ".settings-actions" de la vista, que es el de "Cobertura de agencias", y
    // la Fase 7 terminaba adentro de esa tarjeta.
    var anchor = document.getElementById('cfg_notifCard')
    var firstCard = document.querySelector('#view-config details.cfg')
    if (!anchor && !firstCard) return
    var yesNo = el('select', { id: 'f7_saturday' }, [
      el('option', { value: '', text: 'Sin cargar (calendario apagado)' }),
      el('option', { value: 'true', text: 'Sí, se despacha el sábado' }),
      el('option', { value: 'false', text: 'No, el sábado no' }),
    ])
    var body = el('div', { class: 'cfg-body' }, [
      el('div', { class: 'help', id: 'f7_loadMsg', text: 'Cargando la configuración guardada…' }),
      el('div', { class: 'help', text: 'Cada interruptor se guarda solo al tocarlo. Los demás datos (hora de corte, sábado, feriados, plantillas…) se guardan con el botón "Guardar Fase 7".' }),
      check('f7_orderConfirmEnabled', '7A · Confirmar el pedido con botones antes de subirlo a DroPanas'),
      check('f7_calendarEnabled', '7B · Fechas de despacho y llegada (necesita hora de corte y sábado)'),
      el('div', { class: 'help', id: 'f7_calendarStatus' }),
      field('Hora de corte de despacho (0-23, hora de Caracas)', num('f7_cutoffHour', 'ej. 14')),
      field('¿Se despacha el sábado?', yesNo),
      field('Feriados movibles (AAAA-MM-DD separados por coma: Carnaval, Semana Santa, decretados)', el('textarea', { id: 'f7_holidays', rows: '3' })),
      el('div', { class: 'field' }, [
        el('button', { class: 'btn', type: 'button', id: 'f7_transitPreview', text: 'Recalcular días de tránsito (vista previa)' }),
        el('pre', { id: 'f7_transitOut', class: 'help' }),
        el('button', { class: 'btn', type: 'button', id: 'f7_transitSave', text: 'Guardar esta sugerencia', style: 'display:none' }),
      ]),
      check('f7_quickPickupCouponEnabled', '7C · Cupón por retiro rápido (solo en texto libre al marcar entregado)'),
      field('Días que Tealca guarda el paquete', num('f7_storageDays', 'sin cargar = sin fecha límite')),
      check('f7_storageBusiness', 'Los días de guarda son hábiles'),
      field('Plantilla de fecha límite (aprobada en Meta)', txt('f7_deadlineTpl', 'nombre de la plantilla')),
      el('h4', { text: '📦 Recordatorios de retiro (días 1, 3 y 5)' }),
      field('Calendario de recordatorios', el('select', { id: 'f7_reminderMode' }, [
        el('option', { value: 'fixed', text: 'Fijo: días 1, 3 y 5 desde la llegada (no necesita días de guarda)' }),
        el('option', { value: 'deadline', text: 'Por fecha límite de Tealca (necesita días de guarda)' }),
      ])),
      field('Plantilla de recordatorio, días 1 y 3 (nombre, producto, guía, monto)', txt('f7_reminderTpl', 'recordatorio_retiro_pedido')),
      field('Idioma de esa plantilla', txt('f7_reminderTplLang', 'es')),
      check('f7_lastNoticeEnabled', '7D · Último aviso el día 5, con 3 botones (si está apagado, el día 5 sale un recordatorio normal)'),
      field('Plantilla del último aviso (Utilidad, 3 botones; nombre, producto, guía, monto)', txt('f7_lastNoticeTpl', 'ultimo_aviso_retiro_pedido')),
      field('Máximo de últimos avisos por día (los atrasados salen de a poco, el más viejo primero)', num('f7_lastNoticeCap', '25')),
      el('div', { class: 'field' }, [
        el('button', { class: 'btn', type: 'button', id: 'f7_remindPreview', text: 'Ver quién recibiría hoy' }),
        el('div', { id: 'f7_remindPreviewOut', class: 'help' }),
      ]),
      el('h4', { text: '💸 Descuento por pagar el envío por adelantado' }),
      check('f7_prepayEnabled', 'Ofrecer el descuento al cerrar el pedido (necesita monto del envío y datos de pago móvil)'),
      el('div', { class: 'help', id: 'f7_prepayHint' }),
      field('Descuento general sobre el producto (%). Cada producto puede tener el suyo (en Bs o %) en la pestaña Productos', num('f7_prepayPercent', 'ej. 10')),
      field('Monto del envío que paga por adelantado (tal cual lo verá el cliente)', txt('f7_prepayAmount', 'ej. 450 Bs')),
      field('Datos de pago móvil (banco, teléfono, cédula)', el('textarea', { id: 'f7_prepayInfo', rows: '3', placeholder: 'Banco de Venezuela\n0414-0000000\nV-12.345.678' })),
      field('Si no contesta la oferta, sigue contra entrega después de (minutos)', num('f7_prepayOfferMin', '120')),
      field('Si eligió pagar y no manda la captura, sigue contra entrega después de (horas)', num('f7_prepayPayH', '12')),
      el('div', { class: 'settings-actions' }, [
        el('button', { class: 'btn btn-primary', type: 'button', id: 'f7_save', text: 'Guardar Fase 7' }),
        el('span', { class: 'save-msg', id: 'f7_msg' }),
      ]),
      el('h4', { text: '💸 Pagos del envío por confirmar' }), el('div', { id: 'f7_prepayPending' }),
      el('h4', { text: 'Pedidos sin confirmar' }), el('div', { id: 'f7_unconfirmed' }),
      el('h4', { text: '📞 Llamar hoy' }), el('div', { id: 'f7_callToday' }),
    ])
    var card = el('details', { class: 'card cfg', id: 'f7_card' }, [
      el('summary', { class: 'cfg-head' }, [el('span', { class: 'cfg-title', text: 'Fase 7 · Bajar devoluciones' }), el('span', { class: 'cfg-sub', text: 'Confirmación, calendario, fecha límite, último aviso' })]),
      body,
    ])
    if (anchor) anchor.parentNode.insertBefore(card, anchor)
    else firstCard.parentNode.appendChild(card)
    $('f7_save').addEventListener('click', saveConfig)
    // Cada interruptor guarda SOLO su propio dato. Antes mandaba el formulario
    // entero: si se tocaba antes de que terminara de cargar (Render a veces
    // tarda), se guardaba todo vacio y se borraban la hora de corte, el sabado,
    // los feriados y los demas interruptores (el bot dejaba de dar fechas).
    Object.keys(SWITCHES).forEach(function (id) {
      $(id).addEventListener('change', function () { saveSwitch(id) })
    })
    setEnabled(false)
    $('f7_transitPreview').addEventListener('click', function () { transit(false) })
    $('f7_remindPreview').addEventListener('click', remindPreview)
    $('f7_transitSave').addEventListener('click', function () { transit(true) })
  }

  function say(msg) { var m = $('f7_msg'); if (m) m.textContent = msg }

  var SWITCHES = {
    f7_orderConfirmEnabled: 'orderConfirmEnabled',
    f7_calendarEnabled: 'calendarEnabled',
    f7_quickPickupCouponEnabled: 'quickPickupCouponEnabled',
    f7_lastNoticeEnabled: 'lastNoticeEnabled',
    f7_storageBusiness: 'tealcaStorageBusinessDays',
    f7_prepayEnabled: 'prepayEnabled',
  }
  // Hasta que no llega la configuracion guardada no se puede tocar nada.
  var loaded = false
  function setEnabled(on) {
    var card = $('f7_card')
    if (!card) return
    card.querySelectorAll('.cfg-body input, .cfg-body select, .cfg-body textarea, #f7_save').forEach(function (x) { x.disabled = !on })
  }

  function loadConfig() {
    var msg = $('f7_loadMsg')
    if (msg) msg.textContent = 'Cargando la configuración guardada…'
    if (!loaded) setEnabled(false)
    return call('/settings').then(function (s) {
      fillConfig(s)
      loaded = true
      setEnabled(true)
      if (msg) msg.textContent = ''
    }).catch(function (e) {
      if (msg) msg.textContent = 'No se pudo cargar la configuración (' + e.message + '). Recarga la página antes de cambiar algo.'
    })
  }

  // Igual que calendar.isConfigured del servidor: sin estos datos el bot no da fechas.
  function calendarStatus(s) {
    var box = $('f7_calendarStatus')
    if (!box) return
    var faltan = []
    if (s.dispatchCutoffHour == null || s.dispatchCutoffHour === '') faltan.push('la hora de corte')
    if (typeof s.dispatchOnSaturday !== 'boolean') faltan.push('si se despacha el sábado')
    if (s.calendarEnabled !== true) box.textContent = '⚪ Apagado: el bot no da fechas de llegada.'
    else if (faltan.length) box.textContent = '⚠️ Prendido pero el bot NO está dando fechas: falta ' + faltan.join(' y ') + '. Cárgalo y toca "Guardar Fase 7".'
    else box.textContent = '✅ El bot está dando fechas: corte a las ' + s.dispatchCutoffHour + ':00, sábado ' + (s.dispatchOnSaturday ? 'sí' : 'no') + '.' +
      (Number(s.dispatchCutoffHour) < 6 ? ' ⚠️ Ojo: ' + s.dispatchCutoffHour + ' es de madrugada. Si el corte es en la tarde, usa formato 24 h (ej. 15 = 3 de la tarde).' : '')
  }

  function saveSwitch(id) {
    var input = $(id)
    if (!loaded) { input.checked = !input.checked; return }
    var body = {}
    body[SWITCHES[id]] = input.checked
    if (id === 'f7_prepayEnabled' && input.checked && (!$('f7_prepayAmount').value.trim() || !$('f7_prepayInfo').value.trim())) {
      $('f7_prepayHint').textContent = 'Primero escribe el monto del envío y los datos de pago móvil (abajo), toca "Guardar Fase 7" y después prende este interruptor.'
      input.checked = false
      return
    }
    if (id === 'f7_prepayEnabled') $('f7_prepayHint').textContent = ''
    input.disabled = true
    say('Guardando…')
    call('/settings', { method: 'POST', body: JSON.stringify(body) })
      .then(function (s) {
        input.checked = s[SWITCHES[id]] === true
        calendarStatus(s)
        say(input.checked ? 'Prendido y guardado.' : 'Apagado y guardado.')
      })
      .catch(function (e) { input.checked = !input.checked; say('No se guardó: ' + e.message) })
      .then(function () { input.disabled = false })
  }

  function fillConfig(s) {
    $('f7_orderConfirmEnabled').checked = s.orderConfirmEnabled === true
    $('f7_calendarEnabled').checked = s.calendarEnabled === true
    $('f7_quickPickupCouponEnabled').checked = s.quickPickupCouponEnabled === true
    $('f7_lastNoticeEnabled').checked = s.lastNoticeEnabled === true
    $('f7_storageBusiness').checked = s.tealcaStorageBusinessDays === true
    calendarStatus(s)
    $('f7_cutoffHour').value = s.dispatchCutoffHour == null ? '' : s.dispatchCutoffHour
    $('f7_saturday').value = s.dispatchOnSaturday === true ? 'true' : s.dispatchOnSaturday === false ? 'false' : ''
    $('f7_storageDays').value = s.tealcaStorageDays == null ? '' : s.tealcaStorageDays
    $('f7_holidays').value = (s.holidays || []).join(', ')
    $('f7_deadlineTpl').value = s.pickupDeadlineTemplateName || ''
    $('f7_lastNoticeTpl').value = s.lastNoticeTemplateName || ''
    $('f7_reminderMode').value = s.reminderScheduleMode === 'deadline' ? 'deadline' : 'fixed'
    $('f7_reminderTpl').value = s.pickupReminderTemplateName || ''
    $('f7_reminderTplLang').value = s.pickupReminderTemplateLanguage || 'es'
    $('f7_lastNoticeCap').value = s.lastNoticeDailyCap == null ? '' : s.lastNoticeDailyCap
    $('f7_prepayEnabled').checked = s.prepayEnabled === true
    $('f7_prepayPercent').value = s.prepayDiscountPercent == null ? '' : s.prepayDiscountPercent
    $('f7_prepayAmount').value = s.prepayShippingAmount || ''
    $('f7_prepayInfo').value = s.prepayPaymentInfo || ''
    $('f7_prepayOfferMin').value = s.prepayOfferExpireMin == null ? '' : s.prepayOfferExpireMin
    $('f7_prepayPayH').value = s.prepayPaymentExpireH == null ? '' : s.prepayPaymentExpireH
  }

  function saveConfig() {
    // Nunca se guarda un formulario que no termino de cargar (lo dejaria todo vacio).
    if (!loaded) { say('Espera a que cargue la configuración.'); return }
    var sat = $('f7_saturday').value
    var body = {
      dispatchCutoffHour: $('f7_cutoffHour').value === '' ? null : Number($('f7_cutoffHour').value),
      dispatchOnSaturday: sat === '' ? null : sat === 'true',
      tealcaStorageDays: $('f7_storageDays').value === '' ? null : Number($('f7_storageDays').value),
      holidays: $('f7_holidays').value,
      pickupDeadlineTemplateName: $('f7_deadlineTpl').value,
      lastNoticeTemplateName: $('f7_lastNoticeTpl').value,
      pickupReminderTemplateName: $('f7_reminderTpl').value,
      pickupReminderTemplateLanguage: $('f7_reminderTplLang').value,
      reminderScheduleMode: $('f7_reminderMode').value,
      prepayShippingAmount: $('f7_prepayAmount').value,
      prepayPaymentInfo: $('f7_prepayInfo').value,
    }
    if ($('f7_lastNoticeCap').value !== '') body.lastNoticeDailyCap = Number($('f7_lastNoticeCap').value)
    if ($('f7_prepayPercent').value !== '') body.prepayDiscountPercent = Number($('f7_prepayPercent').value)
    if ($('f7_prepayOfferMin').value !== '') body.prepayOfferExpireMin = Number($('f7_prepayOfferMin').value)
    if ($('f7_prepayPayH').value !== '') body.prepayPaymentExpireH = Number($('f7_prepayPayH').value)
    // Si se borran los datos del descuento, el descuento se apaga.
    if ($('f7_prepayEnabled').checked && (!body.prepayShippingAmount.trim() || !body.prepayPaymentInfo.trim())) body.prepayEnabled = false
    say('Guardando…')
    $('f7_save').disabled = true
    call('/settings', { method: 'POST', body: JSON.stringify(body) })
      .then(function (s) { fillConfig(s); say('✔ Guardado') })
      .catch(function (e) { say('No se guardó: ' + e.message) })
      .then(function () { $('f7_save').disabled = false })
  }

  // Solo lectura: a quien le tocaria hoy un recordatorio o el ultimo aviso, con
  // la plantilla y los datos que se mandarian. No envia nada.
  function remindPreview() {
    var out = $('f7_remindPreviewOut')
    out.textContent = 'Consultando DroPanas…'
    call('/pickup-reminders/preview').then(function (r) {
      out.textContent = ''
      var row = function (x, tipo) {
        return el('div', { class: 'field' }, [el('span', {
          text: (x.nombre || '…' + String(x.phone).slice(-4)) + ' · día ' + (x.dia == null ? '?' : x.dia) + ' · ' + tipo + ': ' + x.plantilla + ' · [' + (x.params || []).join(', ') + ']',
        })])
      }
      out.appendChild(el('div', { text: 'Hoy ' + r.fecha + (r.dropanasRespondio ? '' : ' (DroPanas no respondió: puede faltar gente)') }))
      out.appendChild(el('strong', { text: 'Recordatorios: ' + r.recordara.length }))
      r.recordara.forEach(function (x) { out.appendChild(row(x, 'recordatorio')) })
      var u = r.ultimoAviso || { saldrian: [] }
      out.appendChild(el('strong', { text: 'Último aviso' + (u.prendido ? '' : ' (APAGADO: así saldría si lo prendes)') + ': ' + u.saldrian.length + (u.enEspera ? ' · ' + u.enEspera + ' quedan para los próximos días por el tope diario' : '') }))
      u.saldrian.forEach(function (x) { out.appendChild(row(x, 'último aviso')) })
    }).catch(function (e) { out.textContent = e.message })
  }

  function transit(confirm) {
    call('/calendar/recalculate-transit', { method: 'POST', body: JSON.stringify({ confirm: confirm }) }).then(function (r) {
      $('f7_transitOut').textContent = r.regions.map(function (x) {
        return x.region + ': ' + x.n + ' pedidos, mediana ' + (x.median == null ? '-' : x.median) + ' días' + (x.usesDefault ? ' (pocos datos: se usa el valor por defecto)' : '')
      }).join('\n') + '\nSugerido: ' + JSON.stringify(r.suggested) + (r.saved ? '\n✔ Guardado' : '')
      $('f7_transitSave').style.display = r.saved ? 'none' : ''
    }).catch(function (e) { $('f7_transitOut').textContent = e.message })
  }

  function rowActions(container, rows, label, labelFn, onClick) {
    container.textContent = ''
    if (!rows.length) { container.appendChild(el('div', { class: 'help', text: 'Nada por ahora.' })); return }
    rows.forEach(function (r) {
      container.appendChild(el('div', { class: 'field' }, [
        el('span', { text: labelFn(r) + ' ' }),
        el('button', { class: 'btn', type: 'button', text: label, on: { click: function () { onClick(r) } } }),
      ]))
    })
  }

  function loadPrepay() {
    var box = $('f7_prepayPending')
    if (!box) return
    call('/prepay/pending').then(function (r) {
      box.textContent = ''
      if (!r.rows.length) { box.appendChild(el('div', { class: 'help', text: 'Nada por ahora.' })); return }
      r.rows.forEach(function (x) {
        var label = (x.name || '…' + String(x.phone).slice(-4)) + ' · ' + (x.status === 'receipt_sent' ? 'mandó la captura' : 'esperando la captura') + ' · descuento ' + (x.discountBs != null ? x.discountBs + ' Bs' : x.percent + '%') + (x.total ? ' · producto ' + x.total + ' Bs' : '')
        box.appendChild(el('div', { class: 'field' }, [
          el('span', { text: label + ' ' }),
          x.receiptUrl ? el('a', { href: x.receiptUrl, target: '_blank', rel: 'noopener', text: 'Ver captura' }) : null,
          el('button', { class: 'btn btn-primary', type: 'button', text: '✓ Pago recibido', on: { click: function () { call('/prepay/' + encodeURIComponent(x.phone) + '/decide', { method: 'POST', body: JSON.stringify({ paid: true }) }).then(loadPrepay).catch(function (e) { say(e.message) }) } } }),
          el('button', { class: 'btn', type: 'button', text: '✗ No llegó', on: { click: function () { call('/prepay/' + encodeURIComponent(x.phone) + '/decide', { method: 'POST', body: JSON.stringify({ paid: false }) }).then(loadPrepay).catch(function (e) { say(e.message) }) } } }),
        ]))
      })
    }).catch(function () {})
  }

  function loadLists() {
    loadPrepay()
    call('/order-confirm/unconfirmed').then(function (r) {
      rowActions($('f7_unconfirmed'), r.unconfirmed, 'Marcar confirmado por teléfono',
        function (x) { return (x.name || x.phone) + ' · ' + x.status },
        function (x) { call('/order-confirm/' + encodeURIComponent(x.phone) + '/confirm', { method: 'POST' }).then(loadLists) })
    }).catch(function () {})
    call('/last-notice/call-today').then(function (r) {
      rowActions($('f7_callToday'), r.rows, '📞 Contactado hoy',
        function (x) { return (x.name || x.phone) + ' · ' + (x.agencia || '-') + (x.motivo ? ' · ' + x.motivo + (x.code ? ' (' + x.code + ')' : '') : ' · vence ' + x.deadline) + (x.noReply ? ' · sin respuesta' : '') },
        function (x) { call('/last-notice/' + encodeURIComponent(x.phone) + '/contacted', { method: 'POST', body: '{}' }).then(loadLists) })
    }).catch(function () {})
  }

  /* ---- Reporte de devoluciones en Métricas ---- */
  function buildReport() {
    if ($('f7_report')) return
    var host = document.querySelector('#view-metrics .autos-inner')
    if (!host) return
    host.appendChild(el('div', { class: 'card', id: 'f7_report' }, [
      el('h3', { text: 'Devoluciones' }),
      el('div', { class: 'field' }, [
        el('input', { type: 'date', id: 'f7_from' }), el('input', { type: 'date', id: 'f7_to' }),
        el('button', { class: 'btn', type: 'button', id: 'f7_reportGo', text: 'Ver reporte' }),
        el('a', { class: 'btn', id: 'f7_csv', href: API + '/reports/returns?format=csv', text: 'Descargar CSV' }),
      ]),
      el('div', { id: 'f7_reportOut' }),
    ]))
    $('f7_reportGo').addEventListener('click', loadReport)
  }

  function table(title, rows) {
    var t = el('table', { class: 'table' }, [el('thead', {}, [el('tr', {}, ['Corte', 'Total', 'Entregado', 'Devuelto', 'En curso', 'Tasa %'].map(function (h) { return el('th', { text: h }) }))])])
    var tb = el('tbody')
    rows.forEach(function (r) {
      tb.appendChild(el('tr', {}, [r.key, r.total, r.entregado, r.devuelto, r.en_curso, r.returnRate == null ? '-' : r.returnRate].map(function (v) { return el('td', { text: String(v) }) })))
    })
    t.appendChild(tb)
    return el('div', {}, [el('h4', { text: title }), t])
  }

  function loadReport() {
    var qs = []
    if ($('f7_from').value) qs.push('from=' + $('f7_from').value)
    if ($('f7_to').value) qs.push('to=' + $('f7_to').value)
    $('f7_csv').setAttribute('href', API + '/reports/returns?format=csv' + (qs.length ? '&' + qs.join('&') : ''))
    call('/reports/returns' + (qs.length ? '?' + qs.join('&') : '')).then(function (r) {
      var out = $('f7_reportOut')
      out.textContent = ''
      out.appendChild(el('div', { class: 'help', text: 'Pedidos: ' + r.totals.orders + ' · entregados ' + r.totals.entregado + ' · devueltos ' + r.totals.devuelto + ' · en curso ' + r.totals.en_curso + ' (no cuentan en la tasa) · tasa ' + (r.totals.returnRate == null ? '-' : r.totals.returnRate + '%') + ' · mediana cierre→despacho: ' + (r.medianCloseToDispatchHours == null ? '-' : r.medianCloseToDispatchHours + ' h') }))
      ;[['Por producto', r.byProduct], ['Por región', r.byRegion], ['Por anuncio', r.byAdCode], ['Por confirmación', r.byConfirmation], ['Días en oficina', r.byDaysInOffice], ['Cupón', r.byCoupon], ['Último aviso', r.byLastNotice]].forEach(function (p) { out.appendChild(table(p[0], p[1])) })
      out.appendChild(el('div', { class: 'help', text: 'Motivos: ' + (Object.keys(r.reasons).map(function (k) { return k + ' ' + r.reasons[k] }).join(', ') || 'sin datos') }))
    }).catch(function (e) { $('f7_reportOut').textContent = e.message })
  }

  function onTab(view) {
    if (view === 'view-config') {
      buildConfigCard()
      loadConfig()
      loadLists()
    }
    if (view === 'view-metrics') { buildReport(); loadReport() }
  }

  // OJO: .app-shell tambien tiene data-view (la vista activa), asi que un
  // selector generico '[data-view]' se disparaba con CUALQUIER clic dentro del
  // panel (por ejemplo al tocar un interruptor) y recargaba el formulario desde
  // el servidor, apagando lo que recien se habia marcado. Solo cuentan las pestañas.
  document.addEventListener('click', function (ev) {
    var tab = ev.target.closest && ev.target.closest('.tab[data-view], .more-item[data-view]')
    if (tab) setTimeout(function () { onTab(tab.getAttribute('data-view')) }, 0)
  })
})()
