/* Necesita atención: lista de clientes con reclamo (el bot está en pausa en
   esos chats). Archivo aparte para no tocar app.js. Todo se pinta con
   textContent (nada de innerHTML con datos del cliente). */
(function () {
  'use strict'
  var API = '/panel/api'
  var timer = null

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

  function ago(iso) {
    if (!iso) return ''
    var min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
    if (min < 1) return 'ahora'
    if (min < 60) return 'hace ' + min + ' min'
    var h = Math.round(min / 60)
    if (h < 24) return 'hace ' + h + ' h'
    return 'hace ' + Math.round(h / 24) + ' d'
  }

  var STAGE = {
    nuevo: 'Nuevo', interesado: 'Interesado', negociando: 'Negociando', necesita_atencion: 'Necesita atención',
    vendido: 'Vendido', esperando_guia: 'Esperando guía', en_camino: 'En camino', esperando_retiro: 'Para retirar',
    pendiente_devolucion: 'Pendiente devolución', entregado: 'Entregado', devolucion: 'Devolución',
  }

  // Estilos minimos (no se toca styles.css).
  var css = '.att-badge{position:absolute;top:4px;right:4px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#e5484d;color:#fff;font-size:11px;line-height:18px;text-align:center;font-weight:600}' +
    '.tab{position:relative}' +
    '.att-item{border:1px solid var(--line,#e5e7eb);border-left:4px solid #e5484d;border-radius:10px;padding:12px 14px;margin:10px 0;background:var(--surface,#fff)}' +
    '.att-item h4{margin:0 0 4px;font-size:15px}' +
    '.att-meta{font-size:12px;opacity:.75;margin-bottom:6px}' +
    '.att-reason{display:inline-block;font-size:12px;font-weight:600;color:#b42318;background:#fee4e2;border-radius:6px;padding:2px 8px;margin-bottom:6px}' +
    '.att-text{font-size:13px;margin:4px 0 8px;white-space:pre-wrap}' +
    '.att-actions{display:flex;gap:8px;flex-wrap:wrap}' +
    '.att-wait{font-size:12px;font-weight:600;color:#b54708}'
  document.head.appendChild(el('style', { text: css }))

  function setBadge(n) {
    var b = $('attBadge')
    if (!b) return
    b.hidden = !n
    b.textContent = n > 99 ? '99+' : String(n || '')
  }

  function openChat(phone) {
    try {
      if (typeof window.showView === 'function') window.showView('view-convos')
      if (typeof window.selectConversation === 'function') window.selectConversation(phone)
    } catch (e) { /* si el panel cambia, al menos queda en Conversaciones */ }
  }

  function resolve(phone, reactivate, btn) {
    btn.disabled = true
    call('/attention/' + encodeURIComponent(phone) + '/resolve', { method: 'POST', body: JSON.stringify({ reactivate: reactivate }) })
      .then(load)
      .catch(function (err) { btn.disabled = false; btn.textContent = 'Error: ' + err.message })
  }

  function render(rows) {
    var box = $('att_list')
    if (!box) return
    box.textContent = ''
    setBadge(rows.length)
    if (!rows.length) {
      box.appendChild(el('div', { class: 'help', text: '✓ Nadie necesita atención ahora mismo.' }))
      return
    }
    rows.forEach(function (r) {
      box.appendChild(el('div', { class: 'att-item' }, [
        el('h4', { text: (r.name || '…' + String(r.phone).slice(-4)) }),
        el('div', { class: 'att-meta', text: '…' + String(r.phone).slice(-4) + ' · ' + (STAGE[r.stage] || r.stage) + (r.producto ? ' · ' + r.producto : '') + (r.guia ? ' · guía ' + r.guia : '') + ' · ' + ago(r.at) + (r.paused ? ' · bot en pausa' : ' · bot ACTIVO') }),
        r.reason ? el('div', { class: 'att-reason', text: r.reason + (r.source === 'ia' ? ' (detectado por la IA)' : '') }) : null,
        r.text ? el('div', { class: 'att-text', text: '“' + r.text + '”' }) : null,
        r.lastFromClient ? el('div', { class: 'att-wait', text: 'El cliente espera respuesta (' + ago(r.lastMessageAt) + '): ' + r.lastMessage }) : null,
        el('div', { class: 'att-actions' }, [
          el('button', { class: 'btn btn-primary', type: 'button', text: 'Abrir chat', on: { click: function () { openChat(r.phone) } } }),
          el('button', { class: 'btn', type: 'button', text: '✓ Resuelto (reactivar bot)', on: { click: function (ev) { resolve(r.phone, true, ev.currentTarget) } } }),
          el('button', { class: 'btn', type: 'button', text: '✓ Resuelto (bot sigue en pausa)', on: { click: function (ev) { resolve(r.phone, false, ev.currentTarget) } } }),
        ]),
      ]))
    })
  }

  function load() {
    return call('/attention').then(function (r) { render(r.rows || []) }).catch(function (err) {
      var box = $('att_list')
      if (box) box.textContent = err.message
    })
  }

  function isActive() {
    var v = $('view-attention')
    return v && v.classList.contains('is-active')
  }

  document.addEventListener('click', function (ev) {
    var tab = ev.target.closest && ev.target.closest('.tab[data-view], .more-item[data-view]')
    if (tab && tab.getAttribute('data-view') === 'view-attention') setTimeout(load, 0)
  })

  // Contador del icono cada minuto; la lista se refresca sola si está abierta.
  function tick() {
    if (isActive()) load()
    else call('/attention').then(function (r) { setBadge((r.rows || []).length) }).catch(function () {})
  }
  tick()
  timer = setInterval(tick, 60000)
})()
