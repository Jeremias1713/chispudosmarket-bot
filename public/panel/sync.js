/* S8: bloque "Sincronización" en Automatización DroPanas. Archivo aparte para
   no tocar app.js. Todo se pinta con textContent (nada de innerHTML con datos). */
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
  function $(id) { return document.getElementById(id) }
  function fmt(iso) {
    if (!iso) return '—'
    try { return new Date(iso).toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) } catch (e) { return iso }
  }
  var STAGE = {
    nuevo: 'Nuevo', interesado: 'Interesado', negociando: 'Negociando', vendido: 'Vendido', esperando_guia: 'Esperando guía',
    en_camino: 'En camino', esperando_retiro: 'Para retirar', pendiente_devolucion: 'Pendiente devolución',
    entregado: 'Entregado', devolucion: 'Devolución',
  }
  function st(s) { return STAGE[s] || s || '—' }

  function build() {
    if ($('sy_card')) return
    var host = document.querySelector('#view-dropanas-auto .autos-inner')
    if (!host) return
    var card = el('article', { class: 'card', id: 'sy_card' }, [
      el('h3', { text: '🔄 Sincronización' }),
      el('div', { class: 'help', text: 'Compara el estado actual de cada pedido en DroPanas con la etapa del chat y corrige lo que quedó atrás. Nunca baja una etapa (tampoco en los chats fijados a mano, que también se corrigen). Solo manda mensaje si el cambio en DroPanas es de las últimas 24 horas.' }),
      el('div', { id: 'sy_summary', class: 'help' }),
      el('div', { class: 'field' }, [
        el('label', { class: 'switch' }, [el('input', { type: 'checkbox', id: 'sy_enabled' }), el('span', { text: 'Reconciliación automática cada hora' })]),
      ]),
      el('div', { class: 'field' }, [
        el('button', { class: 'btn', type: 'button', id: 'sy_preview', text: 'Ver vista previa' }),
        el('button', { class: 'btn btn-primary', type: 'button', id: 'sy_apply', text: 'Aplicar corrección' }),
        el('span', { id: 'sy_msg', class: 'help' }),
      ]),
      el('h4', { text: 'Vista previa' }),
      el('div', { id: 'sy_table' }),
      el('h4', { text: 'Avisos vencidos (más de 5 días sin poder enviarse)' }),
      el('div', { id: 'sy_expired' }),
      el('h4', { text: 'Estados de DroPanas no mapeados' }),
      el('div', { class: 'help', text: 'Estados nuevos que el bot no sabe interpretar. Dile a Claude qué significa cada uno.' }),
      el('div', { id: 'sy_unknown' }),
      el('h4', { text: 'Últimas correcciones' }),
      el('div', { id: 'sy_log' }),
    ])
    var anchor = $('da_updated')
    if (anchor && anchor.parentNode === host) host.insertBefore(card, anchor)
    else host.appendChild(card)

    $('sy_preview').addEventListener('click', function () {
      $('sy_msg').textContent = 'Calculando…'
      call('/dropanas/reconcile/preview', { method: 'POST', body: '{}' }).then(function (r) {
        $('sy_msg').textContent = ''
        renderPreview(r.preview || [])
      }).catch(function (err) { $('sy_msg').textContent = err.message })
    })
    $('sy_apply').addEventListener('click', function () {
      var btn = $('sy_apply')
      btn.disabled = true
      $('sy_msg').textContent = 'Aplicando en silencio (sin mensajes a clientes)…'
      call('/dropanas/reconcile/apply', { method: 'POST', body: JSON.stringify({ silent: true }) }).then(function (r) {
        $('sy_msg').textContent = 'Listo: ' + r.summary.corregidos + ' chat(s) corregido(s), ' + r.summary.mensajes + ' mensaje(s).'
        load()
      }).catch(function (err) { $('sy_msg').textContent = err.message }).then(function () { btn.disabled = false })
    })
    $('sy_enabled').addEventListener('change', function () {
      var on = $('sy_enabled').checked
      call('/dropanas/reconcile/enabled', { method: 'POST', body: JSON.stringify({ enabled: on }) }).catch(function (err) {
        $('sy_msg').textContent = err.message
        $('sy_enabled').checked = !on
      })
    })
  }

  function table(headers, rows) {
    if (!rows.length) return el('div', { class: 'help', text: 'Nada por ahora.' })
    var t = el('table', { class: 'table' })
    t.appendChild(el('tr', {}, headers.map(function (h) { return el('th', { text: h }) })))
    rows.forEach(function (r) { t.appendChild(el('tr', {}, r.map(function (c) { return el('td', { text: String(c) }) }))) })
    return el('div', { style: 'overflow-x:auto' }, [t])
  }

  function renderPreview(rows) {
    var box = $('sy_table')
    box.textContent = ''
    var changes = rows.filter(function (r) { return r.accion === 'advance' || r.accion === 'suggest' })
    box.appendChild(table(['Teléfono', 'Cliente', 'DroPanas', 'Etapa actual → nueva', 'Mensaje'], changes.map(function (r) {
      return ['…' + String(r.phone).slice(-4), r.cliente || '—', r.estado, st(r.etapaActual) + ' → ' + st(r.etapaNueva), r.mensaje ? 'sí' : 'no']
    })))
    var others = rows.filter(function (r) { return r.accion === 'report' })
    if (others.length) box.appendChild(el('div', { class: 'help', text: others.length + ' pedido(s) cancelados o con estado desconocido: no se tocan.' }))
  }

  function render(r) {
    var last = r.lastReconcile
    $('sy_summary').textContent = last
      ? 'Última corrida: ' + fmt(last.at) + ' · revisados ' + last.revisados + ' · corregidos ' + last.corregidos + ' · mensajes ' + last.mensajes + (last.errores ? ' · errores ' + last.errores : '')
      : 'Todavía no se aplicó ninguna corrección. Revisa la vista previa y toca "Aplicar corrección" (la primera vez es silenciosa).'
    $('sy_enabled').checked = Boolean(r.enabled)
    if (r.lastReconcileDry && r.lastReconcileDry.preview) renderPreview(r.lastReconcileDry.preview)
    var exp = $('sy_expired')
    exp.textContent = ''
    exp.appendChild(el('div', { class: 'help', text: (r.expired || 0) + ' vencido(s)' + (r.nextRetryAt ? ' · próximo reintento ' + fmt(r.nextRetryAt) : '') + ' · en cola ' + (r.pending || 0) }))
    exp.appendChild(table(['Pedido', 'Guía', 'Estado', 'Motivo', 'Venció'], (r.recentExpired || []).map(function (e) {
      return [e.orderId || '—', e.guia || '—', e.estado || '—', e.reason || '—', fmt(e.expiredAt)]
    })))
    var unk = $('sy_unknown')
    unk.textContent = ''
    unk.appendChild(table(['Estado', 'Veces', 'Último', 'Pedido de ejemplo'], Object.keys(r.unknownStatuses || {}).map(function (k) {
      var u = r.unknownStatuses[k]
      return [k, u.count, fmt(u.lastAt), u.ejemploOrderId || '—']
    })))
    var log = $('sy_log')
    log.textContent = ''
    log.appendChild(table(['Fecha', 'Teléfono', 'Pedido', 'DroPanas', 'Cambio', 'Mensaje'], (r.log || []).slice(0, 30).map(function (e) {
      return [fmt(e.at), e.phone, e.dropanasId, e.estado, st(e.from) + ' → ' + st(e.to), e.mensaje ? 'sí' : 'no']
    })))
  }

  function load() {
    build()
    if (!$('sy_card')) return
    call('/dropanas/reconcile/status').then(render).catch(function (err) { $('sy_summary').textContent = err.message })
  }

  document.addEventListener('click', function (ev) {
    var tab = ev.target.closest && ev.target.closest('.tab[data-view], .more-item[data-view]')
    if (tab && tab.getAttribute('data-view') === 'view-dropanas-auto') setTimeout(load, 0)
    if (ev.target.closest && ev.target.closest('#da_refresh')) setTimeout(load, 0)
  })
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load)
  else load()
})()
