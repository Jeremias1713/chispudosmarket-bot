/* ============================================================
   Panel del bot — JS vanilla, sin frameworks ni build step.
   Todo el estado en vivo llega por polling cada 4s.
   ============================================================ */

const $ = (id) => document.getElementById(id)
const POLL_MS = 4000

const state = {
  selectedPhone: null,
  activeView: 'view-convos',
  stages: [],
  pipelineWindow: '',
  pipelineFrom: '',
  pipelineTo: '',
  chatPhone: null,
  libFolder: '',
  libSearch: '',
}

/* ---------- utilidades ---------- */

async function api(path, options) {
  const res = await fetch('/panel/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || res.statusText)
  }
  return res.json()
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c])
}

function showError(err) {
  alert('No se pudo guardar: ' + err.message)
}

function displayName(convo) {
  return convo.name || `+${convo.phone}`
}

function subtitle(convo) {
  return `+${convo.phone}`
}

function initials(convo) {
  const words = (convo.name ?? '').trim().split(/\s+/).filter((w) => /^[a-záéíóúñ]/i.test(w))
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return String(convo.phone || '??').replace(/\D/g, '').slice(-2)
}

function fmtTime(ts) {
  if (!ts) return ''
  const date = new Date(ts)
  const isToday = new Date().toDateString() === date.toDateString()
  return isToday
    ? date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('es', { day: '2-digit', month: '2-digit' })
}

function timeInStage(ts) {
  if (!ts) return ''
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000)
  if (mins < 1) return 'recién'
  if (mins < 60) return `hace ${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `hace ${hours} h`
  return `hace ${Math.floor(hours / 24)} d`
}

async function loadStages() {
  try {
    state.stages = await api('/stages')
  } catch {
    state.stages = []
  }
}

function stageLabel(id) {
  return state.stages.find((s) => s.id === id)?.label ?? id
}

function stageBadge(convo) {
  if (!convo.stage) return ''
  const pin = convo.stageLocked ? ' 📌' : ''
  const title = convo.stageLocked ? 'Etapa fijada a mano' : (convo.stageReason || 'Etapa asignada por la IA')
  return `<span class="badge" data-stage="${esc(convo.stage)}" title="${esc(title)}">${esc(stageLabel(convo.stage))}${pin}</span>`
}

function convoTags(convo) {
  const tags = []
  if (convo.paused) {
    tags.push('<span class="badge badge-warning">Tomaste el control</span>')
  }
  return tags
}

function emptyState(icon, title, desc) {
  return `<div class="empty-state">
    <div class="icon">${icon}</div>
    <div class="title">${esc(title)}</div>
    <div class="desc">${esc(desc)}</div>
  </div>`
}

/* ---------- navegación por pestañas ---------- */

function showView(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.id === viewId))
  state.activeView = viewId
  document.querySelector('.app-shell').dataset.view = viewId
  document.querySelectorAll('.tab').forEach((t) => {
    t.setAttribute('aria-selected', String(t.dataset.view === viewId))
  })
  const tab = document.querySelector(`.tab[data-view="${viewId}"]`)
  $('viewTitle').textContent = tab?.dataset.label ?? ''
  if (viewId === 'view-pipeline') pollPipeline()
  if (viewId === 'view-metrics') pollMetrics()
  if (viewId === 'view-products') pollProducts()
  if (viewId === 'view-library') pollLibrary()
  if (viewId === 'view-broadcast') loadBroadcastView()
  if (viewId === 'view-sim') pollSimulator()
  if (viewId === 'view-coupons') pollCoupons()
  if (viewId === 'view-config') loadSettings()
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => showView(tab.dataset.view))
})

/* ---------- reloj ---------- */

function tickClock() {
  const el = $('clock')
  if (el) el.textContent = new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
}
setInterval(tickClock, 1000)
tickClock()

/* ---------- lista de conversaciones ---------- */

function convoInner(convo) {
  const tags = [stageBadge(convo), ...convoTags(convo)].filter(Boolean)
  return `<span class="avatar">${esc(initials(convo))}</span>
    <div class="convo-item-body">
      <div class="convo-item-top">
        <span class="convo-item-name">${esc(displayName(convo))}</span>
        <span class="convo-item-time">${fmtTime(convo.lastMessageAt)}</span>
      </div>
      <div class="convo-item-last">${esc(convo.lastMessage || 'Sin mensajes')}</div>
      ${tags.length ? `<div class="convo-item-tags">${tags.join('')}</div>` : ''}
    </div>`
}

let convoCache = []

function renderConvoList(list) {
  convoCache = list
  const box = $('convoList')
  box.innerHTML = ''

  if (!list.length) {
    box.innerHTML = emptyState('💬', 'Sin conversaciones todavía', 'En cuanto alguien le escriba al bot, va a aparecer acá.')
    return
  }

  list.forEach((convo) => {
    const el = document.createElement('div')
    el.className = 'convo-item' + (convo.phone === state.selectedPhone ? ' is-active' : '')
    el.dataset.phone = convo.phone
    el.innerHTML = convoInner(convo)
    el.addEventListener('click', () => selectConversation(convo.phone))
    box.appendChild(el)
  })
}

async function pollConversations() {
  const search = $('convoSearch').value.trim()
  let list
  try {
    list = await api('/conversations' + (search ? `?search=${encodeURIComponent(search)}` : ''))
  } catch {
    return
  }
  renderConvoList(list)
}

let searchTimer = null
$('convoSearch').addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(pollConversations, 200)
})

function selectConversation(phone) {
  state.selectedPhone = phone
  document.querySelectorAll('.convo-item').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.phone === phone)
  })
  document.getElementById('convoLayout')?.classList.add('show-chat')
  loadChat()
}

$('chatBack').addEventListener('click', () => {
  document.getElementById('convoLayout')?.classList.remove('show-chat')
})

/* ---------- ficha del cliente ---------- */

const MEMORY_FIELDS = [
  ['nombre', 'Nombre'],
  ['ciudad', 'Ciudad'],
  ['telefono', 'Teléfono'],
  ['producto', 'Producto'],
  ['notas', 'Notas'],
]

function renderMemory(convo) {
  const box = $('memoryCard')
  const card = convo.card || {}
  const cargados = MEMORY_FIELDS.filter(([col]) => card[col])

  if (!cargados.length) {
    box.hidden = true
    return
  }
  box.hidden = false
  box.innerHTML = '<span class="memory-title">El bot recuerda</span>' +
    cargados.map(([col, label]) => `
      <span class="memory-chip">
        <b>${esc(label)}:</b> ${esc(card[col])}
      </span>`).join('')
}

/* ---------- historial de mensajes ---------- */

const ROLE_LABEL = { user: 'Cliente', assistant: 'Bot', human: 'Vos' }

function bubbleInner(m) {
  return `<span class="bubble-text">${esc(m.content).replace(/\n/g, '<br>')}</span>` +
    `<span class="bubble-meta">${ROLE_LABEL[m.role] ?? m.role} · ${fmtTime(m.at)}</span>`
}

function renderMessages(messages) {
  const box = $('chatMessages')
  if (!messages.length) {
    box.innerHTML = emptyState('💬', 'Sin mensajes', 'Esta conversación todavía no tiene historial.')
    return
  }
  box.innerHTML = messages.map((m) => `<div class="bubble bubble-${m.role}">${bubbleInner(m)}</div>`).join('')
  box.scrollTop = box.scrollHeight
}

/* ---------- etapa ---------- */

async function setStage(body) {
  try {
    await api('/conversations/' + encodeURIComponent(state.selectedPhone) + '/stage', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  } catch (err) {
    showError(err)
  }
  loadChat()
  pollConversations()
}

function renderStagePicker(convo) {
  const select = $('chatStage')
  if (select.options.length !== state.stages.length) {
    select.innerHTML = state.stages.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('')
  }
  if (document.activeElement !== select) select.value = convo.stage ?? ''
  select.title = convo.stageReason || 'Etapa del pipeline'
  select.onchange = () => setStage({ stage: select.value })

  const autoBtn = $('chatStageAuto')
  autoBtn.hidden = !convo.stageLocked
  autoBtn.onclick = () => setStage({ auto: true })
}

/* ---------- abrir un chat ---------- */

async function loadChat() {
  if (!state.selectedPhone) return
  let data
  try {
    data = await api('/conversations/' + encodeURIComponent(state.selectedPhone))
  } catch {
    return
  }
  const { conversation, messages } = data
  if (conversation.phone !== state.selectedPhone) return

  $('chatHeader').hidden = false
  $('chatComposer').hidden = false
  $('chatTitle').textContent = displayName(conversation)
  $('chatAvatar').textContent = initials(conversation)
  $('chatSub').textContent = subtitle(conversation)

  const toggle = $('chatBotToggle')
  toggle.checked = !conversation.paused
  toggle.onchange = async () => {
    try {
      await api('/conversations/' + encodeURIComponent(state.selectedPhone) + '/pause', {
        method: 'POST',
        body: JSON.stringify({ paused: !toggle.checked }),
      })
    } catch (err) {
      showError(err)
    }
    loadChat()
    pollConversations()
  }

  renderStagePicker(conversation)
  renderFollowUp(conversation)
  renderAmount(conversation)
  renderNote(conversation)
  renderMemory(conversation)
  renderMessages(messages)
}

/* ---------- guía enviada (seguimiento) ---------- */

async function markFollowUpSent(phone) {
  try {
    await api('/conversations/' + encodeURIComponent(phone) + '/follow-up', { method: 'POST' })
  } catch (err) {
    showError(err)
    return
  }
  if (phone === state.selectedPhone) loadChat()
  if (state.activeView === 'view-metrics') pollMetrics()
}

function followUpLabel(ts) {
  return ts ? `Última guía enviada: ${timeInStage(ts)}` : 'Última guía enviada: nunca'
}

function renderFollowUp(convo) {
  const bar = $('followupBar')
  bar.hidden = false
  $('followupInfo').textContent = followUpLabel(convo.lastFollowUpAt)
  $('followupBtn').onclick = () => markFollowUpSent(convo.phone)
}

/* ---------- monto vendido (ingresos) ---------- */

function renderAmount(convo) {
  $('amountBar').hidden = false
  // El polling cada 4s vuelve a llamar a esto: si el campo esta enfocado
  // (la persona esta escribiendo un monto todavia sin guardar), no le
  // pisamos lo que esta tipeando.
  if (document.activeElement !== $('amountInput')) {
    $('amountInput').value = convo.card?.monto ?? ''
  }
  $('amountSaveBtn').onclick = () => saveAmount(convo.phone)
}

async function saveAmount(phone) {
  const monto = $('amountInput').value
  $('amountInput').blur()
  try {
    await api('/conversations/' + encodeURIComponent(phone) + '/amount', {
      method: 'POST',
      body: JSON.stringify({ monto }),
    })
  } catch (err) {
    showError(err)
    return
  }
  if (state.activeView === 'view-metrics') pollMetrics()
}

/* ---------- nota interna del cliente ---------- */

function renderNote(convo) {
  $('noteBar').hidden = false
  // Mismo cuidado que con el monto: no pisar lo que la persona esta
  // escribiendo si el polling llega mientras el campo esta enfocado.
  if (document.activeElement !== $('noteInput')) {
    $('noteInput').value = convo.note || ''
  }
  $('noteSaveBtn').onclick = () => saveNote(convo.phone)
}

async function saveNote(phone) {
  const note = $('noteInput').value
  $('noteInput').blur()
  try {
    await api('/conversations/' + encodeURIComponent(phone) + '/note', {
      method: 'POST',
      body: JSON.stringify({ note }),
    })
  } catch (err) {
    showError(err)
  }
}

async function sendManual() {
  const input = $('chatInput')
  const text = input.value.trim()
  if (!text || !state.selectedPhone) return

  $('chatSend').disabled = true
  try {
    await api('/conversations/' + encodeURIComponent(state.selectedPhone) + '/send', {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
    input.value = ''
    await loadChat()
    await pollConversations()
  } catch (err) {
    alert('No se pudo enviar: ' + err.message)
  } finally {
    $('chatSend').disabled = false
  }
}

$('chatSend').addEventListener('click', sendManual)
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendManual() })

/* ---------- pipeline (kanban) ---------- */

function pipelineCard(convo) {
  const tags = convoTags(convo)
  const pin = convo.stageLocked ? '<span class="kcard-pin" title="Etapa fijada a mano: la IA no la mueve">📌</span>' : ''
  return `<article class="kcard" draggable="true" data-phone="${esc(convo.phone)}" title="${esc(convo.stageReason || '')}">
    <div class="kcard-top">
      <span class="avatar avatar-sm">${esc(initials(convo))}</span>
      <div class="kcard-ident">
        <div class="kcard-name">${esc(displayName(convo))}</div>
        <div class="kcard-time">${esc(timeInStage(convo.lastMessageAt ?? convo.createdAt))}</div>
      </div>
      ${pin}
    </div>
    <div class="kcard-last">${esc(convo.lastMessage || 'Sin mensajes')}</div>
    ${tags.length ? `<div class="kcard-tags">${tags.join('')}</div>` : ''}
  </article>`
}

const PIPELINE_WINDOWS = {
  '24h': (ms) => ms <= 24 * 60 * 60 * 1000,
  '3d': (ms) => ms <= 3 * 24 * 60 * 60 * 1000,
  '7d': (ms) => ms <= 7 * 24 * 60 * 60 * 1000,
  stale: (ms) => ms > 7 * 24 * 60 * 60 * 1000,
}

function filtrarPorTiempo(list, ventana) {
  if (ventana === 'custom') {
    return filtrarPorRango(list, state.pipelineFrom, state.pipelineTo)
  }
  if (ventana === 'hoy') {
    const hoy = new Date().toDateString()
    return list.filter((c) => {
      const t = c.lastMessageAt ?? c.createdAt
      return t && new Date(t).toDateString() === hoy
    })
  }
  const filtro = PIPELINE_WINDOWS[ventana]
  if (!filtro) return list
  const ahora = Date.now()
  return list.filter((c) => filtro(ahora - new Date(c.lastMessageAt ?? c.createdAt ?? ahora).getTime()))
}

// Rango manual (Desde/Hasta), inclusive en ambas puntas. Si falta uno de los
// dos, el rango queda abierto de ese lado (ej. solo "Desde" = desde esa fecha
// hasta hoy).
function filtrarPorRango(list, from, to) {
  if (!from && !to) return list
  const fromTs = from ? new Date(from + 'T00:00:00').getTime() : -Infinity
  const toTs = to ? new Date(to + 'T23:59:59').getTime() : Infinity
  return list.filter((c) => {
    const t = c.lastMessageAt ?? c.createdAt
    if (!t) return false
    const ts = new Date(t).getTime()
    return ts >= fromTs && ts <= toTs
  })
}

function clearPipelineChips() {
  $('pipelineFilters').querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('is-on'))
}

$('pipelineFilters').addEventListener('click', (e) => {
  const chip = e.target.closest('.filter-chip')
  if (!chip) return
  state.pipelineWindow = chip.dataset.window
  state.pipelineFrom = ''
  state.pipelineTo = ''
  $('pipelineFrom').value = ''
  $('pipelineTo').value = ''
  $('pipelineClearRange').hidden = true
  clearPipelineChips()
  chip.classList.add('is-on')
  pollPipeline()
})

$('pipelineApplyRange').addEventListener('click', () => {
  const from = $('pipelineFrom').value
  const to = $('pipelineTo').value
  if (!from && !to) return
  state.pipelineWindow = 'custom'
  state.pipelineFrom = from
  state.pipelineTo = to
  clearPipelineChips()
  $('pipelineClearRange').hidden = false
  pollPipeline()
})

$('pipelineClearRange').addEventListener('click', () => {
  state.pipelineWindow = ''
  state.pipelineFrom = ''
  state.pipelineTo = ''
  $('pipelineFrom').value = ''
  $('pipelineTo').value = ''
  $('pipelineClearRange').hidden = true
  clearPipelineChips()
  $('pipelineFilters').querySelector('.filter-chip[data-window=""]').classList.add('is-on')
  pollPipeline()
})

function renderBoard(list) {
  const grouped = new Map(state.stages.map((s) => [s.id, []]))
  for (const convo of list) {
    const bucket = grouped.get(convo.stage) ?? grouped.get(state.stages[0]?.id)
    bucket?.push(convo)
  }

  $('board').innerHTML = state.stages.map((s) => {
    const cards = grouped.get(s.id) ?? []
    return `<section class="kcol" data-stage="${esc(s.id)}">
      <header class="kcol-head">
        <span class="badge" data-stage="${esc(s.id)}">${esc(s.label)}</span>
        <span class="kcol-count">${cards.length}</span>
      </header>
      <div class="kcol-body">
        ${cards.length ? cards.map(pipelineCard).join('') : '<p class="kcol-empty">Vacía</p>'}
      </div>
    </section>`
  }).join('')

  bindBoardEvents()
}

async function dropOnStage(phone, stage) {
  try {
    await api('/conversations/' + encodeURIComponent(phone) + '/stage', {
      method: 'POST',
      body: JSON.stringify({ stage }),
    })
  } catch (err) {
    showError(err)
  }
  pollPipeline()
}

function bindBoardEvents() {
  let draggingPhone = null

  $('board').querySelectorAll('.kcard').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      draggingPhone = card.dataset.phone
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', card.dataset.phone)
      card.classList.add('is-dragging')
    })
    card.addEventListener('dragend', () => card.classList.remove('is-dragging'))
    card.addEventListener('click', () => {
      showView('view-convos')
      selectConversation(card.dataset.phone)
    })
  })

  $('board').querySelectorAll('.kcol').forEach((col) => {
    col.addEventListener('dragover', (e) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      col.classList.add('is-over')
    })
    col.addEventListener('dragleave', () => col.classList.remove('is-over'))
    col.addEventListener('drop', (e) => {
      e.preventDefault()
      col.classList.remove('is-over')
      const phone = e.dataTransfer.getData('text/plain') || draggingPhone
      draggingPhone = null
      if (phone) dropOnStage(phone, col.dataset.stage)
    })
  })
}

async function pollPipeline() {
  let list
  try {
    list = await api('/conversations')
  } catch {
    return
  }
  renderBoard(filtrarPorTiempo(list, state.pipelineWindow))
}

/* ---------- métricas ---------- */

function fmtPercent(value) {
  return value == null ? '—' : `${value.toFixed(1)}%`
}

function fmtMoney(value) {
  return (value || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function metricsTiles(m) {
  const tiles = [
    ['Conversaciones', m.total],
    ['Mensajes hoy', m.messagesToday],
    ['Conversión (nuevo→vendido)', fmtPercent(m.conversionRate)],
    ['Necesitan seguimiento', m.staleAttention.length],
    ['Ingresos (vendido)', fmtMoney(m.revenue)],
  ]
  return tiles.map(([label, value]) => `
    <div class="metric-tile">
      <div class="metric-tile-value">${esc(value)}</div>
      <div class="metric-tile-label">${esc(label)}</div>
    </div>`).join('')
}

function metricsFunnel(byStage) {
  const max = Math.max(1, ...state.stages.map((s) => byStage[s.id] || 0))
  return state.stages.map((s) => {
    const count = byStage[s.id] || 0
    const pct = Math.round((count / max) * 100)
    return `<div class="funnel-row">
      <span class="funnel-label">${esc(s.label)}</span>
      <span class="funnel-track"><span class="funnel-fill" style="width:${pct}%"></span></span>
      <span class="funnel-count">${esc(count)}</span>
    </div>`
  }).join('')
}

function staleRow(c) {
  const doneTag = c.lastFollowUpAt
    ? `<span class="stale-followup-done">Guía: ${esc(timeInStage(c.lastFollowUpAt))}</span>`
    : ''
  return `<div class="stale-row" data-phone="${esc(c.phone)}">
    <div class="stale-who">
      <div class="stale-name">${esc(c.name || `+${c.phone}`)}</div>
      <div class="stale-phone">+${esc(c.phone)}</div>
    </div>
    <span class="badge" data-stage="${esc(c.stage)}">${esc(stageLabel(c.stage))}</span>
    <span class="stale-since">${c.hoursSinceLastMessage != null ? esc(timeInStage(c.lastMessageAt)) : 'sin mensajes'}</span>
    <div class="stale-actions">
      ${doneTag}
      <button class="btn stale-open" type="button">Abrir</button>
      <button class="btn stale-followup" type="button">Marcar guía enviada</button>
    </div>
  </div>`
}

function locationRow(loc) {
  return `<div class="location-row">
    <span class="location-name">${esc(loc.ciudad)}</span>
    <span class="location-count">${esc(loc.count)} pedido${loc.count === 1 ? '' : 's'}</span>
  </div>`
}

function productRow(p) {
  return `<div class="location-row">
    <span class="location-name">${esc(p.producto)}</span>
    <span class="location-count">${esc(p.count)} vendido${p.count === 1 ? '' : 's'}${p.revenue ? ' · ' + fmtMoney(p.revenue) : ''}</span>
  </div>`
}

async function pollMetrics() {
  if (state.activeView !== 'view-metrics') return
  let m
  try { m = await api('/metrics') } catch { return }

  $('metricsCards').innerHTML = metricsTiles(m)
  $('metricsFunnel').innerHTML = metricsFunnel(m.byStage)

  $('metricsStale').innerHTML = m.staleAttention.length
    ? m.staleAttention.map(staleRow).join('')
    : emptyState('✅', 'Nadie esperando seguimiento', 'Cuando una conversación se quede sin novedad, va a aparecer acá.')

  $('metricsStale').querySelectorAll('.stale-row').forEach((row) => {
    const phone = row.dataset.phone
    row.querySelector('.stale-open').addEventListener('click', () => {
      showView('view-convos')
      selectConversation(phone)
    })
    row.querySelector('.stale-followup').addEventListener('click', () => markFollowUpSent(phone))
  })

  $('metricsLocations').innerHTML = m.topLocations.length
    ? m.topLocations.map(locationRow).join('')
    : emptyState('📍', 'Todavía no hay ciudades cargadas', 'Aparecen apenas el bot anote la ciudad de algún cliente.')

  $('metricsProducts').innerHTML = (m.topProducts || []).length
    ? m.topProducts.map(productRow).join('')
    : emptyState('🏆', 'Todavía no hay ventas cargadas', 'Aparece apenas marques una conversación como "Vendido" con su producto.')
}

/* ---------- catálogo de productos ---------- */

let libraryCache = []
let productDrawerOpen = false
let editingProductId = null

function productCard(p) {
  const imgIds = p.introImageIds || []
  const badges = [
    p.active === false ? '<span class="badge badge-warning">Pausado</span>' : '',
    p.prompt ? '<span class="badge">Prompt propio</span>' : '',
    (p.triggers && p.triggers.length) ? '<span class="badge">Palabras gatillo</span>' : '',
    imgIds.length > 1 ? `<span class="badge">${imgIds.length} fotos</span>` : '',
  ].filter(Boolean).join('')

  const img = imgIds.length ? libraryCache.find((i) => i.id === imgIds[0]) : null
  const thumb = img
    ? `<img src="/media/${esc(img.filename)}" alt="${esc(p.name)}">`
    : '<span class="product-noimg">Sin foto</span>'

  return `<article class="product-card card" data-id="${esc(p.id)}">
    <div class="product-thumb">${thumb}</div>
    <div class="product-body">
      <div class="product-name">${esc(p.name || 'Sin nombre')}</div>
      <div class="product-price">${p.price ? esc(Number(p.price).toFixed(2) + ' ' + p.currency) : 'Sin precio'}</div>
      ${badges}
    </div>
  </article>`
}

let productCache = []

async function pollProducts() {
  if (state.activeView !== 'view-products') return
  let list
  try { list = await api('/products') } catch { return }
  productCache = list
  try { libraryCache = await api('/library') } catch { /* ya la tenemos de antes, no importa */ }

  if (productDrawerOpen) return

  $('productGrid').innerHTML = list.length
    ? list.map(productCard).join('')
    : emptyState('📦', 'Todavía no hay productos', 'Cargá tu primer producto para que el bot sepa qué vende y a qué precio.')

  $('productGrid').querySelectorAll('.product-card').forEach((el) => {
    el.addEventListener('click', () => openProduct(list.find((p) => p.id === el.dataset.id)))
  })
}

/* ---------- selector visual de imágenes (con miniaturas y buscador) ---------- */
/* Reemplaza a los <select multiple> de toda la vida: elegir una foto de la
   biblioteca sin tener que acordarse de nombres largos en una lista de texto. */

const imagePickers = {}

function renderImagePickerGrid(key) {
  const root = document.querySelector(`.img-picker[data-picker="${key}"]`)
  if (!root || !imagePickers[key]) return
  const search = root.querySelector('.img-picker-search').value.trim().toLowerCase()
  const grid = root.querySelector('.img-picker-grid')
  const empty = root.querySelector('.img-picker-empty')
  const selected = new Set(imagePickers[key].selectedIds)
  const items = libraryCache.filter((img) => !search || img.name.toLowerCase().includes(search))

  empty.hidden = items.length > 0 || libraryCache.length === 0
  if (!libraryCache.length) {
    grid.innerHTML = ''
    empty.hidden = false
    empty.textContent = 'Todavía no subiste ninguna imagen (pestaña Imágenes).'
    return
  }
  empty.textContent = 'No hay imágenes con ese nombre.'

  grid.innerHTML = items.map((img) => `
    <label class="img-picker-item${selected.has(img.id) ? ' is-selected' : ''}" data-id="${esc(img.id)}">
      <img src="/media/${esc(img.filename)}" alt="${esc(img.name)}" loading="lazy">
      <span class="img-picker-name">${esc(img.name)}</span>
      ${selected.has(img.id) ? '<span class="img-picker-check">✓</span>' : ''}
    </label>`).join('')

  grid.querySelectorAll('.img-picker-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id
      const st = imagePickers[key]
      const i = st.selectedIds.indexOf(id)
      if (i === -1) st.selectedIds.push(id)
      else st.selectedIds.splice(i, 1)
      renderImagePickerGrid(key)
    })
  })
}

function initImagePicker(key, selectedIds) {
  imagePickers[key] = { selectedIds: [...(selectedIds || [])] }
  renderImagePickerGrid(key)
}

function getImagePickerSelection(key) {
  return imagePickers[key]?.selectedIds || []
}

document.querySelectorAll('.img-picker').forEach((root) => {
  const key = root.dataset.picker
  root.querySelector('.img-picker-search').addEventListener('input', () => renderImagePickerGrid(key))
})

function openProduct(p) {
  editingProductId = p ? p.id : null
  productDrawerOpen = true

  $('productFormTitle').textContent = p ? 'Editar producto' : 'Nuevo producto'
  $('p_name').value = p?.name || ''
  $('p_price').value = p?.price ?? ''
  $('p_currency').value = p?.currency || 'Bs'
  $('p_active').value = p && p.active === false ? '0' : '1'
  $('p_sku').value = p?.sku || ''
  $('p_description').value = p?.description || ''
  $('p_prompt').value = p?.prompt || ''
  $('p_triggers').value = (p?.triggers || []).join(', ')
  $('p_intro').value = p?.intro || ''
  $('p_upsell').value = p?.upsell || ''
  initImagePicker('introImage', p?.introImageIds)
  $('productMsg').textContent = ''
  $('deleteProduct').hidden = !p
  $('productDrawer').hidden = false
}

function closeProductDrawer() {
  productDrawerOpen = false
  $('productDrawer').hidden = true
  pollProducts()
}

$('newProduct').addEventListener('click', () => openProduct(null))
$('closeProduct').addEventListener('click', closeProductDrawer)

$('saveProduct').addEventListener('click', async () => {
  const body = {
    name: $('p_name').value.trim(),
    price: Number($('p_price').value) || 0,
    currency: $('p_currency').value.trim() || 'Bs',
    active: $('p_active').value === '1',
    sku: $('p_sku').value.trim(),
    description: $('p_description').value,
    prompt: $('p_prompt').value,
    triggers: $('p_triggers').value,
    intro: $('p_intro').value,
    introImageIds: getImagePickerSelection('introImage'),
    upsell: $('p_upsell').value,
  }
  if (!body.name) {
    $('productMsg').textContent = 'Falta el nombre'
    return
  }
  try {
    if (editingProductId) {
      await api('/products/' + encodeURIComponent(editingProductId), { method: 'POST', body: JSON.stringify(body) })
    } else {
      await api('/products', { method: 'POST', body: JSON.stringify(body) })
    }
    closeProductDrawer()
  } catch (err) {
    $('productMsg').textContent = err.message
  }
})

$('deleteProduct').addEventListener('click', async () => {
  if (!editingProductId) return
  if (!confirm('¿Borrar este producto?')) return
  try {
    await api('/products/' + encodeURIComponent(editingProductId), { method: 'DELETE' })
    closeProductDrawer()
  } catch (err) {
    $('productMsg').textContent = err.message
  }
})

/* ---------- biblioteca de imágenes ---------- */

const NO_FOLDER = '__sin_carpeta__'

function folderOptionsHtml(current, folders) {
  const opts = [`<option value="" ${!current ? 'selected' : ''}>Sin carpeta</option>`]
    .concat(folders.map((f) => `<option value="${esc(f)}" ${f === current ? 'selected' : ''}>${esc(f)}</option>`))
    .concat(['<option value="__nueva__">+ Nueva carpeta…</option>'])
  return opts.join('')
}

function libCard(img, folders) {
  return `<article class="lib-card card" data-id="${esc(img.id)}">
    <div class="lib-thumb"><img src="/media/${esc(img.filename)}" alt="${esc(img.name)}" loading="lazy"></div>
    <div class="lib-body">
      <div class="lib-name lib-rename" title="Tocá para renombrar">${esc(img.name)}</div>
      <select class="lib-folder-select">${folderOptionsHtml(img.folder || '', folders)}</select>
      <div class="lib-foot">
        <button class="btn lib-del" aria-label="Borrar imagen">Borrar</button>
      </div>
    </div>
  </article>`
}

function currentLibraryFolders() {
  const set = new Set()
  libraryCache.forEach((img) => { if (img.folder) set.add(img.folder) })
  return [...set].sort((a, b) => a.localeCompare(b, 'es'))
}

function renderLibFolderChips(folders) {
  const chips = [
    `<button class="filter-chip${state.libFolder === '' ? ' is-on' : ''}" type="button" data-folder="">Todas</button>`,
    `<button class="filter-chip${state.libFolder === NO_FOLDER ? ' is-on' : ''}" type="button" data-folder="${NO_FOLDER}">Sin carpeta</button>`,
    ...folders.map((f) => `<button class="filter-chip${state.libFolder === f ? ' is-on' : ''}" type="button" data-folder="${esc(f)}">${esc(f)}</button>`),
  ]
  $('libFolders').innerHTML = chips.join('')
  $('libFolders').querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.libFolder = btn.dataset.folder
      pollLibrary()
    })
  })
}

async function pollLibrary() {
  if (state.activeView !== 'view-library') return
  let list
  try { list = await api('/library') } catch { return }
  libraryCache = list

  const folders = currentLibraryFolders()
  renderLibFolderChips(folders)

  const search = state.libSearch.trim().toLowerCase()
  let filtered = list
  if (state.libFolder === NO_FOLDER) filtered = filtered.filter((img) => !img.folder)
  else if (state.libFolder) filtered = filtered.filter((img) => img.folder === state.libFolder)
  if (search) filtered = filtered.filter((img) => img.name.toLowerCase().includes(search))

  $('libGrid').innerHTML = filtered.length
    ? filtered.map((img) => libCard(img, folders)).join('')
    : emptyState('🖼️', list.length ? 'Nada con ese filtro' : 'Todavía no subiste ninguna imagen', list.length ? 'Probá con otra carpeta o borrá la búsqueda.' : 'Subila y ponele un nombre claro para reconocerla al elegir la foto de un producto.')

  $('libGrid').querySelectorAll('.lib-card').forEach((card) => {
    const id = card.dataset.id
    card.querySelector('.lib-del').addEventListener('click', async () => {
      if (!confirm('¿Borrar esta imagen? Los productos que la usen se quedan sin foto.')) return
      try {
        await api('/library/' + encodeURIComponent(id), { method: 'DELETE' })
        pollLibrary()
      } catch (err) { showError(err) }
    })
    card.querySelector('.lib-rename').addEventListener('click', async () => {
      const img = libraryCache.find((i) => i.id === id)
      const nombre = prompt('¿Cómo se llama esta imagen?', img?.name || '')
      if (nombre === null || !nombre.trim()) return
      try {
        await api('/library/' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify({ name: nombre.trim() }) })
        pollLibrary()
      } catch (err) { showError(err) }
    })
    card.querySelector('.lib-folder-select').addEventListener('change', async (e) => {
      let folder = e.target.value
      if (folder === '__nueva__') {
        const nueva = prompt('Nombre de la carpeta nueva:')
        if (!nueva || !nueva.trim()) { pollLibrary(); return }
        folder = nueva.trim()
      }
      try {
        await api('/library/' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify({ folder }) })
        pollLibrary()
      } catch (err) { showError(err) }
    })
  })
}

let libSearchTimer = null
$('libSearch').addEventListener('input', () => {
  state.libSearch = $('libSearch').value
  clearTimeout(libSearchTimer)
  libSearchTimer = setTimeout(pollLibrary, 200)
})

// Sube uno o varios archivos de una. El nombre sale del nombre del archivo
// (se puede corregir después tocando el nombre en la grilla), y si estás
// mirando una carpeta puntual las nuevas fotos caen ahí directo.
$('libFile').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || [])
  if (!files.length) return
  e.target.value = ''

  const folder = state.libFolder && state.libFolder !== NO_FOLDER ? state.libFolder : ''
  const label = $('libUploadLabel')
  const errors = []

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (label) label.textContent = files.length > 1 ? `Subiendo ${i + 1}/${files.length}…` : 'Subiendo…'
    const nombre = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || file.name

    const formData = new FormData()
    formData.append('file', file)
    formData.append('name', nombre)
    if (folder) formData.append('folder', folder)

    try {
      const res = await fetch('/panel/api/library', { method: 'POST', body: formData })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || res.statusText)
      }
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`)
    }
  }

  if (label) label.textContent = 'Subir imágenes'
  pollLibrary()
  if (errors.length) alert('Algunas imágenes no se pudieron subir:\n' + errors.join('\n'))
})

/* ---------- envíos masivos ---------- */

$('bc_scope').addEventListener('change', () => {
  $('bc_stageWrap').hidden = $('bc_scope').value !== 'stage'
})

function bcHistoryRow(run) {
  const statusLabel = run.status === 'running' ? 'Enviando…' : 'Terminado'
  return `<div class="run-row">
    <div class="run-row-main">
      <strong>${esc(run.templateName)}</strong>
      <span class="badge">${esc(statusLabel)}</span>
    </div>
    <div class="run-row-sub">
      ${esc(run.sent)} enviados, ${esc(run.failed)} fallidos de ${esc(run.total)} · ${fmtTime(run.startedAt)}
    </div>
  </div>`
}

async function loadBroadcastView() {
  if (!$('bc_stage').options.length) {
    $('bc_stage').innerHTML = state.stages.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('')
  }
  try {
    const { templates } = await api('/templates')
    $('bc_templateList').innerHTML = (templates || []).map((t) => `<option value="${esc(t.name)}"></option>`).join('')
  } catch { /* sigue andando con el campo libre */ }
  pollBroadcasts()
}

async function pollBroadcasts() {
  if (state.activeView !== 'view-broadcast') return
  let runs
  try { runs = await api('/broadcasts') } catch { return }
  $('bc_history').innerHTML = runs.length
    ? runs.map(bcHistoryRow).join('')
    : emptyState('📨', 'Todavía no mandaste ningún envío masivo', 'Elegí una plantilla aprobada y a quién mandársela arriba.')
}

$('bc_send').addEventListener('click', async () => {
  const templateName = $('bc_template').value.trim()
  if (!templateName) {
    $('bc_msg').textContent = 'Falta el nombre de la plantilla'
    return
  }
  const params = $('bc_params').value.split(',').map((s) => s.trim()).filter(Boolean)
  const target = $('bc_scope').value === 'stage'
    ? { scope: 'stage', stage: $('bc_stage').value }
    : { scope: 'all' }

  $('bc_send').disabled = true
  $('bc_msg').textContent = ''
  try {
    await api('/broadcasts', {
      method: 'POST',
      body: JSON.stringify({ templateName, languageCode: $('bc_lang').value.trim() || 'es', params, target }),
    })
    $('bc_msg').textContent = 'Envío arrancado'
    pollBroadcasts()
  } catch (err) {
    $('bc_msg').textContent = err.message
  } finally {
    $('bc_send').disabled = false
  }
})

/* ---------- simulador ---------- */

function simBubbleInner(m) {
  return `<span class="bubble-text">${esc(m.content).replace(/\n/g, '<br>')}</span>` +
    `<span class="bubble-meta">${ROLE_LABEL[m.role] ?? m.role} · ${fmtTime(m.at)}</span>`
}

function renderSimState(simState) {
  $('simStageLabel').textContent = 'Etapa: ' + stageLabel(simState.stage)

  const box = $('simMessages')
  box.innerHTML = simState.history.length
    ? simState.history.map((m) => `<div class="bubble bubble-${m.role}">${simBubbleInner(m)}</div>`).join('')
    : `<div class="empty-state">
        <div class="icon">🧪</div>
        <div class="title">Probá el bot acá</div>
        <div class="desc">Nada de esto sale por WhatsApp de verdad: es la misma IA y el mismo catálogo, en un chat de prueba.</div>
      </div>`
  box.scrollTop = box.scrollHeight

  const card = simState.card || {}
  const cargados = MEMORY_FIELDS.filter(([col]) => card[col])
  const memoryBox = $('simMemoryCard')
  memoryBox.innerHTML = cargados.length
    ? '<span class="memory-title">El bot recuerda</span>' +
      cargados.map(([col, label]) => `<span class="memory-chip"><b>${esc(label)}:</b> ${esc(card[col])}</span>`).join('')
    : '<span class="memory-title">El bot todavía no anotó nada</span>'
}

async function pollSimulator() {
  if (state.activeView !== 'view-sim') return
  try {
    renderSimState(await api('/simulator'))
  } catch { /* nada que mostrar todavía */ }
}

async function simSendMessage() {
  const input = $('simInput')
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  $('simSend').disabled = true
  try {
    const result = await api('/simulator/message', { method: 'POST', body: JSON.stringify({ text }) })
    renderSimState(result.state)
  } catch (err) {
    showError(err)
  } finally {
    $('simSend').disabled = false
  }
}

$('simSend').addEventListener('click', simSendMessage)
$('simInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') simSendMessage() })

$('sim_sendLoc').addEventListener('click', async () => {
  const lat = Number($('sim_lat').value)
  const lng = Number($('sim_lng').value)
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    alert('Poné una latitud y longitud válidas')
    return
  }
  try {
    const result = await api('/simulator/location', { method: 'POST', body: JSON.stringify({ lat, lng }) })
    renderSimState(result.state)
  } catch (err) { showError(err) }
})

$('sim_reset').addEventListener('click', async () => {
  try {
    renderSimState(await api('/simulator/reset', { method: 'POST' }))
  } catch (err) { showError(err) }
})

/* ---------- configuración ---------- */

function bindRangeDisplay(rangeId, valId, suffix) {
  const range = $(rangeId)
  const val = $(valId)
  const update = () => { val.textContent = range.value + (suffix || '') }
  range.addEventListener('input', update)
  return update
}

const updateTempDisplay = bindRangeDisplay('cfg_temperature', 'cfg_temperature_val')
const updateHistoryDisplay = bindRangeDisplay('cfg_historyN', 'cfg_historyN_val')
const updateReplyDelayDisplay = bindRangeDisplay('cfg_replyDelay', 'cfg_replyDelay_val', ' s')
const updateMaxWordsDisplay = bindRangeDisplay('cfg_maxWords', 'cfg_maxWords_val', ' palabras')
const updateMaxWordsHardCapDisplay = bindRangeDisplay('cfg_maxWordsHardCap', 'cfg_maxWordsHardCap_val', ' palabras')
const updateMaxPartsDisplay = bindRangeDisplay('cfg_maxParts', 'cfg_maxParts_val', ' mensajes')
const updateSplitMinWordsDisplay = bindRangeDisplay('cfg_splitMinWords', 'cfg_splitMinWords_val', ' palabras')
const updateSplitGapMinDisplay = bindRangeDisplay('cfg_splitGapMin', 'cfg_splitGapMin_val', ' s')
const updateSplitGapMaxDisplay = bindRangeDisplay('cfg_splitGapMax', 'cfg_splitGapMax_val', ' s')

async function loadSettings() {
  let s
  try { s = await api('/settings') } catch { return }
  $('cfg_botToggle').checked = s.botEnabled !== false
  $('cfg_businessName').value = s.businessName || ''
  $('cfg_welcome').value = s.welcomeMessage || ''
  $('cfg_knowledge').value = s.knowledgeBase || ''
  $('cfg_model').value = s.openaiModel || ''
  $('cfg_temperature').value = s.openaiTemperature ?? 0.7
  $('cfg_historyN').value = s.openaiHistoryN ?? 12
  $('cfg_replyDelay').value = Math.round((s.replyDelayMs ?? 8000) / 1000)
  $('cfg_maxWords').value = s.maxWordsPerMessage ?? 30
  $('cfg_maxWordsHardCap').value = s.maxWordsHardCap ?? 90
  $('cfg_maxParts').value = s.maxMessageParts ?? 5
  $('cfg_splitEnabled').checked = s.splitRepliesEnabled !== false
  $('cfg_splitMinWords').value = s.splitMinWords ?? 3
  $('cfg_splitGapMin').value = (s.splitGapMinMs ?? 6000) / 1000
  $('cfg_splitGapMax').value = (s.splitGapMaxMs ?? 9500) / 1000
  $('cfg_audioEnabled').checked = s.audioReplyEnabled !== false
  try { libraryCache = await api('/library') } catch { /* si falla, el selector queda vacío */ }
  initImagePicker('welcomeImage', s.welcomeImageIds)
  updateTempDisplay()
  updateHistoryDisplay()
  updateReplyDelayDisplay()
  updateMaxWordsDisplay()
  updateMaxWordsHardCapDisplay()
  updateMaxPartsDisplay()
  updateSplitMinWordsDisplay()
  updateSplitGapMinDisplay()
  updateSplitGapMaxDisplay()
  $('cfg_msg').textContent = ''
  loadAgenciesMeta()
}

$('cfg_save').addEventListener('click', async () => {
  const body = {
    botEnabled: $('cfg_botToggle').checked,
    businessName: $('cfg_businessName').value.trim(),
    welcomeMessage: $('cfg_welcome').value,
    welcomeImageIds: getImagePickerSelection('welcomeImage'),
    knowledgeBase: $('cfg_knowledge').value,
    openaiModel: $('cfg_model').value.trim(),
    openaiTemperature: Number($('cfg_temperature').value),
    openaiHistoryN: Number($('cfg_historyN').value),
    replyDelayMs: Number($('cfg_replyDelay').value) * 1000,
    maxWordsPerMessage: Number($('cfg_maxWords').value),
    maxWordsHardCap: Number($('cfg_maxWordsHardCap').value),
    maxMessageParts: Number($('cfg_maxParts').value),
    splitRepliesEnabled: $('cfg_splitEnabled').checked,
    splitMinWords: Number($('cfg_splitMinWords').value),
    splitGapMinMs: Math.round(Number($('cfg_splitGapMin').value) * 1000),
    splitGapMaxMs: Math.round(Number($('cfg_splitGapMax').value) * 1000),
    audioReplyEnabled: $('cfg_audioEnabled').checked,
  }
  $('cfg_save').disabled = true
  try {
    await api('/settings', { method: 'POST', body: JSON.stringify(body) })
    $('cfg_msg').textContent = 'Guardado'
    setTimeout(() => { $('cfg_msg').textContent = '' }, 1600)
  } catch (err) {
    $('cfg_msg').textContent = err.message
  } finally {
    $('cfg_save').disabled = false
  }
})

$('backup_download').addEventListener('click', async () => {
  $('backup_download').disabled = true
  $('backup_msg').textContent = 'Generando...'
  try {
    const res = await fetch('/panel/api/backup')
    if (!res.ok) throw new Error('No se pudo generar la copia')
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `chispudos-backup-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    $('backup_msg').textContent = 'Listo, revisá tus descargas'
    setTimeout(() => { $('backup_msg').textContent = '' }, 2500)
  } catch (err) {
    $('backup_msg').textContent = err.message
  } finally {
    $('backup_download').disabled = false
  }
})

$('csv_download').addEventListener('click', async () => {
  $('csv_download').disabled = true
  $('backup_msg').textContent = 'Generando...'
  try {
    const res = await fetch('/panel/api/export.csv')
    if (!res.ok) throw new Error('No se pudo generar el archivo')
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `chispudos-ventas-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    $('backup_msg').textContent = 'Listo, revisá tus descargas'
    setTimeout(() => { $('backup_msg').textContent = '' }, 2500)
  } catch (err) {
    $('backup_msg').textContent = err.message
  } finally {
    $('csv_download').disabled = false
  }
})

/* ---------- cobertura de agencias ---------- */

async function loadAgenciesMeta() {
  const box = $('agencies_meta')
  try {
    const meta = await api('/agencies/meta')
    if (!meta.count) {
      box.textContent = 'Todavía no hay agencias cargadas.'
      return
    }
    const fecha = meta.updatedAt ? new Date(meta.updatedAt).toLocaleString('es-VE') : ''
    box.textContent = `${meta.count} agencias cargadas en ${meta.regions} estados/regiones.` + (fecha ? ` Actualizado: ${fecha}.` : '')
  } catch (err) {
    box.textContent = 'No pude leer el listado de agencias.'
  }
}

$('agencies_upload').addEventListener('click', async () => {
  const file = $('agencies_file').files?.[0]
  if (!file) { $('agencies_msg').textContent = 'Elegí un archivo primero'; return }

  const formData = new FormData()
  formData.append('file', file)

  $('agencies_upload').disabled = true
  $('agencies_msg').textContent = 'Importando…'
  try {
    const res = await fetch('/panel/api/agencies/import', { method: 'POST', body: formData })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || res.statusText)
    }
    const meta = await res.json()
    $('agencies_file').value = ''
    $('agencies_msg').textContent = `Listo: ${meta.count} agencias cargadas`
    setTimeout(() => { $('agencies_msg').textContent = '' }, 2500)
    loadAgenciesMeta()
  } catch (err) {
    $('agencies_msg').textContent = err.message
  } finally {
    $('agencies_upload').disabled = false
  }
})

/* ---------- cupones ---------- */

let couponCache = []

function couponRow(c) {
  const stateBadge = c.active === false
    ? '<span class="badge badge-warning">Pausado</span>'
    : '<span class="badge">Activo</span>'
  return `<div class="coupon-row" data-id="${esc(c.id)}">
    <span class="coupon-code">${esc(c.code)}</span>
    <span class="coupon-discount">${esc(c.discountPercent)}%</span>
    <span class="coupon-desc">${esc(c.description || 'Sin descripción')}</span>
    ${stateBadge}
    <div class="coupon-actions">
      <button class="btn coupon-toggle" type="button">${c.active === false ? 'Activar' : 'Pausar'}</button>
      <button class="btn btn-danger coupon-del" type="button">Borrar</button>
    </div>
  </div>`
}

async function pollCoupons() {
  if (state.activeView !== 'view-coupons') return
  let list
  try { list = await api('/coupons') } catch { return }
  couponCache = list

  $('cp_list').innerHTML = list.length
    ? list.map(couponRow).join('')
    : emptyState('🏷️', 'Todavía no hay cupones', 'Cargá el primero para que el bot lo pueda ofrecer.')

  $('cp_list').querySelectorAll('.coupon-row').forEach((row) => {
    const id = row.dataset.id
    const coupon = couponCache.find((c) => c.id === id)
    row.querySelector('.coupon-toggle').addEventListener('click', async () => {
      try {
        await api('/coupons/' + encodeURIComponent(id), {
          method: 'POST',
          body: JSON.stringify({ active: coupon.active === false }),
        })
        pollCoupons()
      } catch (err) { showError(err) }
    })
    row.querySelector('.coupon-del').addEventListener('click', async () => {
      if (!confirm('¿Borrar este cupón?')) return
      try {
        await api('/coupons/' + encodeURIComponent(id), { method: 'DELETE' })
        pollCoupons()
      } catch (err) { showError(err) }
    })
  })
}

$('cp_save').addEventListener('click', async () => {
  const body = {
    code: $('cp_code').value.trim(),
    discountPercent: Number($('cp_discount').value) || 0,
    description: $('cp_description').value.trim(),
    active: $('cp_active').value === '1',
  }
  if (!body.code) {
    $('cp_msg').textContent = 'Falta el código'
    return
  }
  $('cp_save').disabled = true
  try {
    await api('/coupons', { method: 'POST', body: JSON.stringify(body) })
    $('cp_code').value = ''
    $('cp_discount').value = ''
    $('cp_description').value = ''
    $('cp_active').value = '1'
    $('cp_msg').textContent = 'Cupón agregado'
    setTimeout(() => { $('cp_msg').textContent = '' }, 1600)
    pollCoupons()
  } catch (err) {
    $('cp_msg').textContent = err.message
  } finally {
    $('cp_save').disabled = false
  }
})

/* ---------- arranque ---------- */

async function boot() {
  await loadStages()
  await pollConversations()
  setInterval(() => {
    pollConversations()
    if (state.selectedPhone) loadChat()
    if (state.activeView === 'view-pipeline') pollPipeline()
    if (state.activeView === 'view-metrics') pollMetrics()
    if (state.activeView === 'view-products') pollProducts()
    if (state.activeView === 'view-library') pollLibrary()
    if (state.activeView === 'view-broadcast') pollBroadcasts()
    if (state.activeView === 'view-sim') pollSimulator()
    if (state.activeView === 'view-coupons') pollCoupons()
  }, POLL_MS)
}

boot()
