// Sitio publico: landing simple y politica de privacidad. Esto es lo que
// Meta pide para poder publicar la app de WhatsApp (necesita una URL de
// politica de privacidad) y tambien sirve como pagina de presentacion del
// negocio para cualquiera que entre a la URL del servidor.
const express = require('express');

const BUSINESS_NAME = process.env.BUSINESS_NAME || 'ChispudosMarket';
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'contacto@chispudosmarket.com';

const router = express.Router();

const BASE_STYLE = `
  :root { color-scheme: light dark; }
    body { margin: 0; font-family: system-ui, sans-serif; line-height: 1.6; background: #0b0f14; color: #e8e8e8; }
      .wrap { max-width: 720px; margin: 0 auto; padding: 32px 20px 64px; }
        header { padding: 48px 20px 24px; text-align: center; }
          header h1 { font-size: 28px; margin: 0 0 8px; }
            header p { opacity: .75; margin: 0; }
              .card { background: #131a22; border: 1px solid #ffffff1a; border-radius: 12px; padding: 24px; margin-top: 24px; }
                .card h2 { font-size: 18px; margin-top: 0; }
                  a { color: #4a90e2; }
                    .btn { display: inline-block; background: #25d366; color: #0b0f14; font-weight: 600; text-decoration: none; padding: 12px 22px; border-radius: 8px; margin-top: 8px; }
                      footer { text-align: center; opacity: .6; font-size: 13px; padding: 24px 20px; }
                        h2, h3 { color: #fff; }
                        `;

                        router.get('/', (_req, res) => {
                          res.type('html').send(`<!doctype html>
                          <html lang="es">
                          <head>
                          <meta charset="utf-8" />
                          <meta name="viewport" content="width=device-width, initial-scale=1" />
                          <title>${BUSINESS_NAME}</title>
                          <style>${BASE_STYLE}</style>
                          </head>
                          <body>
                            <header>
                                <h1>${BUSINESS_NAME}</h1>
                                    <p>Atencion y ventas por WhatsApp, todos los dias.</p>
                                      </header>
                                        <div class="wrap">
                                            <div class="card">
                                                  <h2>Como funciona</h2>
                                                        <p>Escribinos por WhatsApp y un asesor (con ayuda de inteligencia artificial) te va a responder al toque: te contamos que productos tenemos, resolvemos tus dudas y te conectamos con la agencia mas cercana a tu ubicacion.</p>
                                                              <a class="btn" href="https://wa.me/" target="_blank" rel="noopener">Escribinos por WhatsApp</a>
                                                                  </div>
                                                                      <div class="card">
                                                                            <h2>Sobre nosotros</h2>
                                                                                  <p>${BUSINESS_NAME} es un negocio que vende y asesora a sus clientes directamente por WhatsApp, de forma rapida y sin vueltas.</p>
                                                                                      </div>
                                                                                          <div class="card">
                                                                                                <h2>Contacto</h2>
                                                                                                      <p>Email: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
                                                                                                            <p><a href="/privacidad">Politica de privacidad</a></p>
                                                                                                                </div>
                                                                                                                  </div>
                                                                                                                    <footer>${BUSINESS_NAME} &middot; ${new Date().getFullYear()}</footer>
                                                                                                                    </body>
                                                                                                                    </html>`);
                                                                                                                    });
                                                                                                                    
                                                                                                                    router.get('/privacidad', (_req, res) => {
                                                                                                                      res.type('html').send(`<!doctype html>
                                                                                                                      <html lang="es">
                                                                                                                      <head>
                                                                                                                      <meta charset="utf-8" />
                                                                                                                      <meta name="viewport" content="width=device-width, initial-scale=1" />
                                                                                                                      <title>Politica de privacidad - ${BUSINESS_NAME}</title>
                                                                                                                      <style>${BASE_STYLE}</style>
                                                                                                                      </head>
                                                                                                                      <body>
                                                                                                                        <header>
                                                                                                                            <h1>Politica de privacidad</h1>
                                                                                                                                <p>${BUSINESS_NAME}</p>
                                                                                                                                  </header>
                                                                                                                                    <div class="wrap">
                                                                                                                                        <div class="card">
                                                                                                                                              <h2>Que datos recibimos</h2>
                                                                                                                                                    <p>Cuando nos escribis por WhatsApp recibimos tu numero de telefono, tu nombre de perfil, y el contenido de los mensajes que nos mandas (texto o tu ubicacion, si decidis compartirla). No accedemos a ningun otro dato de tu telefono ni de tu cuenta de WhatsApp.</p>
                                                                                                                                                        </div>
                                                                                                                                                            <div class="card">
                                                                                                                                                                  <h2>Para que usamos tus datos</h2>
                                                                                                                                                                        <p>Usamos esta informacion unicamente para responderte, asesorarte sobre nuestros productos y servicios, y para encontrar la agencia o sucursal mas cercana a vos cuando compartis tu ubicacion. Parte de las respuestas se generan con ayuda de un modelo de inteligencia artificial (OpenAI), al que se le envia el texto de la conversacion para poder responderte.</p>
                                                                                                                                                                            </div>
                                                                                                                                                                                <div class="card">
                                                                                                                                                                                      <h2>Con quien compartimos tus datos</h2>
                                                                                                                                                                                            <p>No vendemos ni compartimos tus datos con terceros para fines publicitarios. Tus mensajes pasan por la plataforma de WhatsApp Business (Meta) para poder llegar hasta nosotros, y por OpenAI para poder generar las respuestas automaticas, unicamente como parte del funcionamiento del servicio.</p>
                                                                                                                                                                                                </div>
                                                                                                                                                                                                    <div class="card">
                                                                                                                                                                                                          <h2>Cuanto tiempo guardamos tus datos</h2>
                                                                                                                                                                                                                <p>Guardamos el historial de tu conversacion mientras mantengamos una relacion comercial activa con vos, para poder darte un mejor seguimiento. Podes pedirnos en cualquier momento que borremos tus datos escribiendonos por WhatsApp o por email.</p>
                                                                                                                                                                                                                    </div>
                                                                                                                                                                                                                        <div class="card">
                                                                                                                                                                                                                              <h2>Tus derechos</h2>
                                                                                                                                                                                                                                    <p>Podes pedirnos en cualquier momento acceder, corregir o borrar tus datos personales. Para eso, escribinos a <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> o por WhatsApp.</p>
                                                                                                                                                                                                                                        </div>
                                                                                                                                                                                                                                            <div class="card">
                                                                                                                                                                                                                                                  <h2>Contacto</h2>
                                                                                                                                                                                                                                                        <p>Si tenes dudas sobre esta politica de privacidad, escribinos a <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
                                                                                                                                                                                                                                                            </div>
                                                                                                                                                                                                                                                                <div class="card">
                                                                                                                                                                                                                                                                      <p style="opacity:.7; font-size: 13px;">Ultima actualizacion: 28 de agosto de 2026.</p>
                                                                                                                                                                                                                                                                          </div>
                                                                                                                                                                                                                                                                              <p><a href="/">Volver al inicio</a></p>
                                                                                                                                                                                                                                                                                </div>
                                                                                                                                                                                                                                                                                  <footer>${BUSINESS_NAME} &middot; ${new Date().getFullYear()}</footer>
                                                                                                                                                                                                                                                                                  </body>
                                                                                                                                                                                                                                                                                  </html>`);
                                                                                                                                                                                                                                                                                  });
                                                                                                                                                                                                                                                                                  
                                                                                                                                                                                                                                                                                  module.exports = router;
                                                                                                                                                                                                                                                                                  
