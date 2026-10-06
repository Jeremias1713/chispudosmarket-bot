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
    var actions = document.querySelector('#view-config .settings-actions')
    if (!actions) return
    var yesNo = el('select', { id: 'f7_saturday' }, [
      el('option', { value: '', text: 'Sin cargar (calendario apagado)' }),
      el('option', { value: 'true', text: 'Sí, se despacha el sábado' }),
      el('option', { value: 'false', text: 'No, el sábado no' }),
    ])
    var body = el('div', { class: 'cfg-body' }, [
      el('div', { class: 'help', text: 'Todo arranca APAGADO. Cada pieza tiene su interruptor; carga primero los datos que necesita.' }),
      check('f7_orderConfirmEnabled', '7A · Confirmar el pedido con botones antes de subirlo a DroPanas'),
      check('f7_calendarEnabled', '7B · Fechas de despacho y llegada (necesita hora de corte y sábado)'),
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
      check('f7_lastNoticeEnabled', '7D · Último aviso antes de la devolución (necesita días de guarda)'),
      field('Plantilla del último aviso (Utilidad, 3 botones)', txt('f7_lastNoticeTpl', 'nombre de la plantilla')),
      el('div', { class: 'settings-actions' }, [
        el('button', { class: 'btn btn-primary', type: 'button', id: 'f7_save', text: 'Guardar Fase 7' }),
        el('span', { class: 'save-msg', id: 'f7_msg' }),
      ]),
      el('h4', { text: 'Pedidos sin confirmar' }), el('div', { id: 'f7_unconfirmed' }),
      el('h4', { text: '📞 Llamar hoy' }), el('div', { id: 'f7_callToday' }),
    ])
    var card = el('details', { class: 'card cfg', id: 'f7_card' }, [
      el('summary', { class: 'cfg-head' }, [el('span', { class: 'cfg-title', text: 'Fase 7 · Bajar devoluciones' }), el('span', { class: 'cfg-sub', text: 'Confirmación, calendario, fecha límite, último aviso' })]),
      body,
    ])
    actions.parentNode.insertBefore(card, actions)
    $('f7_save').addEventListener('click', saveConfig)
    // Los interruptores se guardan al tocarlos (antes habia que acordarse de "Guardar Fase 7").
    ;['f7_orderConfirmEnabled', 'f7_calendarEnabled', 'f7_quickPickupCouponEnabled', 'f7_lastNoticeEnabled', 'f7_storageBusiness'].forEach(function (id) {
      $(id).addEventListener('change', saveConfig)
    })
    $('f7_transitPreview').addEventListener('click', function () { transit(false) })
    $('f7_transitSave').addEventListener('click', function () { transit(true) })
  }

  function say(msg) { var m = $('f7_msg'); if (m) m.textContent = msg }

  function fillConfig(s) {
    $('f7_orderConfirmEnabled').checked = s.orderConfirmEnabled === true
    $('f7_calendarEnabled').checked = s.calendarEnabled === true
    $('f7_quickPickupCouponEnabled').checked = s.quickPickupCouponEnabled === true
    $('f7_lastNoticeEnabled').checked = s.lastNoticeEnabled === true
    $('f7_storageBusiness').checked = s.tealcaStorageBusinessDays === true
    $('f7_cutoffHour').value = s.dispatchCutoffHour == null ? '' : s.dispatchCutoffHour
    $('f7_saturday').value = s.dispatchOnSaturday === true ? 'true' : s.dispatchOnSaturday === false ? 'false' : ''
    $('f7_storageDays').value = s.tealcaStorageDays == null ? '' : s.tealcaStorageDays
    $('f7_holidays').value = (s.holidays || []).join(', ')
    $('f7_deadlineTpl').value = s.pickupDeadlineTemplateName || ''
    $('f7_lastNoticeTpl').value = s.lastNoticeTemplateName || ''
  }

  function saveConfig() {
    var sat = $('f7_saturday').value
    var body = {
      orderConfirmEnabled: $('f7_orderConfirmEnabled').checked,
      calendarEnabled: $('f7_calendarEnabled').checked,
      quickPickupCouponEnabled: $('f7_quickPickupCouponEnabled').checked,
      lastNoticeEnabled: $('f7_lastNoticeEnabled').checked,
      tealcaStorageBusinessDays: $('f7_storageBusiness').checked,
      dispatchCutoffHour: $('f7_cutoffHour').value === '' ? null : Number($('f7_cutoffHour').value),
      dispatchOnSaturday: sat === '' ? null : sat === 'true',
      tealcaStorageDays: $('f7_storageDays').value === '' ? null : Number($('f7_storageDays').value),
      holidays: $('f7_holidays').value,
      pickupDeadlineTemplateName: $('f7_deadlineTpl').value,
      lastNoticeTemplateName: $('f7_lastNoticeTpl').value,
    }
    call('/settings', { method: 'POST', body: JSON.stringify(body) })
      .then(function (s) { fillConfig(s); say('Guardado') })
      .catch(function (e) { say(e.message) })
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

  function loadLists() {
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
      call('/settings').then(fillConfig).catch(function () {})
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
