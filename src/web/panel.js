// Panel web simple de solo lectura para ver las conversaciones sin abrir
// WhatsApp: lista de chats con su etapa y ficha del cliente, y el historial
// completo de cada uno. Protegido con usuario/clave (HTTP Basic Auth) leidos
// de las variables de entorno PANEL_USER / PANEL_PASS.
const express = require('express');
const { listSessions, getSession } = require('../state');

function basicAuth(req, res, next) {
  const user = process.env.PANEL_USER;
    const pass = process.env.PANEL_PASS;

      if (!user || !pass) {
          return res
                .status(503)
                      .send('El panel no esta configurado. Falta PANEL_USER / PANEL_PASS en las variables de entorno.');
                        }

                          const header = req.headers.authorization || '';
                            const [scheme, encoded] = header.split(' ');

                              if (scheme === 'Basic' && encoded) {
                                  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
                                      const sep = decoded.indexOf(':');
                                          const u = decoded.slice(0, sep);
                                              const p = decoded.slice(sep + 1);
                                                  if (u === user && p === pass) return next();
                                                    }

                                                      res.set('WWW-Authenticate', 'Basic realm="Panel de ventas"');
                                                        return res.status(401).send('Autenticacion requerida.');
                                                        }

                                                        const router = express.Router();
                                                        router.use(basicAuth);

                                                        router.get('/api/sessions', (_req, res) => {
                                                          const sessions = listSessions()
                                                              .map((s) => ({
                                                                    phone: s.phone,
                                                                          stage: s.stage || 'nuevo',
                                                                                card: s.card || {},
                                                                                      lastMessage: (s.history || []).slice(-1)[0]?.content || '',
                                                                                            updatedAt: s.updatedAt || s.createdAt || null,
                                                                                                }))
                                                                                                    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
                                                                                                      res.json(sessions);
                                                                                                      });
                                                                                                      
                                                                                                      router.get('/api/sessions/:phone', (req, res) => {
                                                                                                        const session = getSession(req.params.phone);
                                                                                                          res.json({ phone: req.params.phone, ...session });
                                                                                                          });
                                                                                                          
                                                                                                          router.get('/', (_req, res) => {
                                                                                                            res.type('html').send(PANEL_HTML);
                                                                                                            });
                                                                                                            
                                                                                                            const PANEL_HTML = `<!doctype html>
                                                                                                            <html lang="es">
                                                                                                            <head>
                                                                                                            <meta charset="utf-8" />
                                                                                                            <meta name="viewport" content="width=device-width, initial-scale=1" />
                                                                                                            <title>Panel de ventas</title>
                                                                                                            <style>
                                                                                                              :root { color-scheme: light dark; }
                                                                                                                body { margin: 0; font-family: system-ui, sans-serif; display: flex; height: 100vh; }
                                                                                                                  #list { width: 320px; border-right: 1px solid #8884; overflow-y: auto; }
                                                                                                                    #list h1 { font-size: 15px; padding: 12px; margin: 0; border-bottom: 1px solid #8884; }
                                                                                                                      .chat-item { padding: 10px 12px; border-bottom: 1px solid #8882; cursor: pointer; }
                                                                                                                        .chat-item:hover { background: #8881; }
                                                                                                                          .chat-item .phone { font-weight: 600; font-size: 13px; }
                                                                                                                            .chat-item .stage { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 8px; background: #4a90e233; margin-left: 6px; }
                                                                                                                              .chat-item .last { font-size: 12px; opacity: .7; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                                                                                                                                #detail { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
                                                                                                                                  #card { padding: 12px; border-bottom: 1px solid #8884; font-size: 13px; }
                                                                                                                                    #card b { display: inline-block; min-width: 80px; }
                                                                                                                                      #messages { flex: 1; overflow-y: auto; padding: 12px; }
                                                                                                                                        .msg { max-width: 70%; padding: 8px 10px; border-radius: 10px; margin-bottom: 8px; font-size: 14px; white-space: pre-wrap; }
                                                                                                                                          .msg.user { background: #4a90e233; margin-right: auto; }
                                                                                                                                            .msg.assistant { background: #8882; margin-left: auto; }
                                                                                                                                              .empty { padding: 24px; opacity: .6; font-size: 14px; }
                                                                                                                                              </style>
                                                                                                                                              </head>
                                                                                                                                              <body>
                                                                                                                                                <div id="list"><h1>Conversaciones</h1><div id="items"></div></div>
                                                                                                                                                  <div id="detail"><div class="empty">Elegi una conversacion de la lista.</div></div>
                                                                                                                                                  
                                                                                                                                                  <script>
                                                                                                                                                  let current = null;
                                                                                                                                                  
                                                                                                                                                  async function loadList() {
                                                                                                                                                    const res = await fetch('/panel/api/sessions');
                                                                                                                                                      const sessions = await res.json();
                                                                                                                                                        const items = document.getElementById('items');
                                                                                                                                                          items.innerHTML = '';
                                                                                                                                                            sessions.forEach((s) => {
                                                                                                                                                                const div = document.createElement('div');
                                                                                                                                                                    div.className = 'chat-item';
                                                                                                                                                                        div.innerHTML = '<div class="phone">' + s.phone + '<span class="stage">' + s.stage + '</span></div>' +
                                                                                                                                                                              '<div class="last">' + (s.card.nombre ? s.card.nombre + ' &middot; ' : '') + (s.lastMessage || '') + '</div>';
                                                                                                                                                                                  div.onclick = () => loadDetail(s.phone);
                                                                                                                                                                                      items.appendChild(div);
                                                                                                                                                                                        });
                                                                                                                                                                                        }
                                                                                                                                                                                        
                                                                                                                                                                                        async function loadDetail(phone) {
                                                                                                                                                                                          current = phone;
                                                                                                                                                                                            const res = await fetch('/panel/api/sessions/' + encodeURIComponent(phone));
                                                                                                                                                                                              const s = await res.json();
                                                                                                                                                                                                const card = s.card || {};
                                                                                                                                                                                                  const detail = document.getElementById('detail');
                                                                                                                                                                                                    const cardHtml = ['nombre', 'ciudad', 'telefono', 'producto', 'notas']
                                                                                                                                                                                                        .map((k) => '<div><b>' + k + ':</b> ' + (card[k] || '-') + '</div>')
                                                                                                                                                                                                            .join('');
                                                                                                                                                                                                              const msgsHtml = (s.history || [])
                                                                                                                                                                                                                  .map((m) => '<div class="msg ' + m.role + '">' + m.content.replace(/</g, '&lt;') + '</div>')
                                                                                                                                                                                                                      .join('');
                                                                                                                                                                                                                        detail.innerHTML =
                                                                                                                                                                                                                            '<div id="card"><b>Telefono:</b> ' + phone + ' &middot; <b>Etapa:</b> ' + (s.stage || 'nuevo') + '<br/>' + cardHtml + '</div>' +
                                                                                                                                                                                                                                '<div id="messages">' + (msgsHtml || '<div class="empty">Sin mensajes todavia.</div>') + '</div>';
                                                                                                                                                                                                                                  detail.querySelector('#messages').scrollTop = detail.querySelector('#messages').scrollHeight;
                                                                                                                                                                                                                                  }
                                                                                                                                                                                                                                  
                                                                                                                                                                                                                                  loadList();
                                                                                                                                                                                                                                  setInterval(() => {
                                                                                                                                                                                                                                    loadList();
                                                                                                                                                                                                                                      if (current) loadDetail(current);
                                                                                                                                                                                                                                      }, 5000);
                                                                                                                                                                                                                                      </script>
                                                                                                                                                                                                                                      </body>
                                                                                                                                                                                                                                      </html>`;
                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                      module.exports = router;
                                                                                                                                                                                                                                      
