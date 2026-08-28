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
  chatPhone: null,
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
  renderMemory(conversation)
  renderMessages(messages)
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
  const filtro = PIPELINE_WINDOWS[ventana]
  if (!filtro) return list
  const ahora = Date.now()
  return list.filter((c) => filtro(ahora - new Date(c.lastMessageAt ?? c.createdAt ?? ahora).getTime()))
}

$('pipelineFilters').addEventListener('click', (e) => {
  const chip = e.target.closest('.filter-chip')
  if (!chip) return
  state.pipelineWindow = chip.dataset.window
  $('pipelineFilters').querySelectorAll('.filter-chip').forEach((c) => c.classList.toggle('is-on', c === chip))
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

/* ---------- arranque ---------- */

async function boot() {
  await loadStages()
  await pollConversations()
  setInterval(() => {
    pollConversations()
    if (state.selectedPhone) loadChat()
    if (state.activeView === 'view-pipeline') pollPipeline()
  }, POLL_MS)
}

boot()
