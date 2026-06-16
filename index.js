// ════════════════════════════════════════════════════════════════════════
//  LEALTECK SERVER  –  MercadoPago subscriptions + Firebase Admin
// ════════════════════════════════════════════════════════════════════════
//  Endpoints:
//    GET  /health                → liveness check
//    POST /registro              → guarda solicitud de nuevo negocio
//    POST /webhook/suscripcion   → MP notifica cambio de suscripción
//    POST /webhook/pago          → MP notifica pago único (tarjeta)
//    POST /crear-preferencia     → genera link de pago MP (uso interno)
//    POST /setup/crear-planes    → crea los 3 planes MP (una sola vez)
//    GET  /planes                → devuelve IDs de los planes guardados
// ════════════════════════════════════════════════════════════════════════

'use strict'

const express   = require('express')
const cors      = require('cors')
const admin     = require('firebase-admin')
const { MercadoPagoConfig, PreApprovalPlan, PreApproval, Preference } = require('mercadopago')
const { Resend } = require('resend')

const resend = new Resend(process.env.RESEND_API_KEY)
const IVAN_EMAIL   = 'ivhe750@gmail.com'
const FROM_EMAIL   = 'Lealteck <onboarding@resend.dev>'

// ── 1. Firebase Admin ─────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // Render guarda los saltos de línea como literales \n; los revertimos
    privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  }),
})
const db = admin.firestore()

// ── 2. MercadoPago ────────────────────────────────────────────────────
const mp = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
})

// ── 3. Express ────────────────────────────────────────────────────────
const app = express()
app.use(cors())
app.use(express.json())

// ─────────────────────────────────────────────────────────────────────
//  PLANES (definidos aquí para usarlos en setup y en /planes)
// ─────────────────────────────────────────────────────────────────────
const PLANES_CONFIG = [
  {
    key:           'lealcard',
    reason:        'LealCard – Sellos y fidelización',
    auto_recurring: {
      frequency:      1,
      frequency_type: 'months',
      transaction_amount: 60,
      currency_id:   'PEN',
      free_trial: { frequency: 7, frequency_type: 'days' },
    },
    back_url: 'https://lealteck.com/gracias',
  },
  {
    key:           'lealorder',
    reason:        'LealOrder – Carta + pedidos WhatsApp',
    auto_recurring: {
      frequency:      1,
      frequency_type: 'months',
      transaction_amount: 90,
      currency_id:   'PEN',
      free_trial: { frequency: 7, frequency_type: 'days' },
    },
    back_url: 'https://lealteck.com/gracias',
  },
  {
    key:           'lealfull',
    reason:        'LealFull – Sellos + Carta + Pedidos',
    auto_recurring: {
      frequency:      1,
      frequency_type: 'months',
      transaction_amount: 120,
      currency_id:   'PEN',
      free_trial: { frequency: 7, frequency_type: 'days' },
    },
    back_url: 'https://lealteck.com/gracias',
  },
]

// ─────────────────────────────────────────────────────────────────────
//  EMAILS
// ─────────────────────────────────────────────────────────────────────
async function enviarEmailBienvenida({ nombre, email, plan, businessId }) {
  const NOMBRE_PLAN = { lealcard: 'LealCard', lealorder: 'LealOrder', lealfull: 'LealFull' }
  try {
    await resend.emails.send({
      from:    FROM_EMAIL,
      to:      email,
      subject: `¡Bienvenido a Lealteck, ${nombre}! Tu cuenta está activa 🎉`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#1c1410">
          <h1 style="color:#c47a3a">¡Hola, ${nombre}!</h1>
          <p>Tu cuenta de Lealteck con el plan <strong>${NOMBRE_PLAN[plan] || plan}</strong> ya está activa.</p>
          <p>Podés acceder a tu panel de administración en:</p>
          <p style="margin:20px 0">
            <a href="https://${businessId}.lealteck.com"
               style="background:#c47a3a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">
              Ir a mi panel →
            </a>
          </p>
          <hr style="border:none;border-top:1px solid #e5d5c0;margin:24px 0">
          <p style="font-weight:700;margin-bottom:8px">🔷 QR para tus clientes</p>
          <p style="color:#8b7355;font-size:0.9rem;margin-bottom:16px">
            Imprimí o mostrá este código QR en tu local. Tus clientes lo escanean
            para acceder a tu carta y programa de fidelización.
          </p>
          <div style="text-align:center;margin:16px 0">
            <img
              src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=https%3A%2F%2F${businessId}.lealteck.com&color=1c1410&bgcolor=ffffff&margin=10"
              alt="QR ${businessId}.lealteck.com"
              width="220" height="220"
              style="border:1px solid #e5d5c0;border-radius:8px"
            />
            <p style="color:#8b7355;font-size:0.82rem;margin-top:8px">${businessId}.lealteck.com</p>
          </div>
          <hr style="border:none;border-top:1px solid #e5d5c0;margin:24px 0">
          <p style="color:#8b7355;font-size:0.9rem">
            Si tenés alguna duda, respondé este email o escribinos por WhatsApp.
            Estamos para ayudarte.
          </p>
          <p style="color:#8b7355;font-size:0.8rem">Lealteck · Plataforma de fidelización para restaurantes y cafés</p>
        </div>
      `,
    })
    console.log('[email] Bienvenida enviada a:', email)
  } catch (err) {
    console.error('[email] Error enviando bienvenida:', err)
  }
}

async function notificarRegistroNuevo({ nombre, rubro, dueno, email, whatsapp, plan, registroId }) {
  const NOMBRE_PLAN = { lealcard: 'LealCard (S/60)', lealorder: 'LealOrder (S/90)', lealfull: 'LealFull (S/120)' }
  try {
    await resend.emails.send({
      from:    FROM_EMAIL,
      to:      IVAN_EMAIL,
      subject: `🆕 Nuevo registro: ${nombre}`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#1c1410">
          <h2>Nuevo negocio registrado</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#8b7355;width:130px">Negocio</td><td><strong>${nombre}</strong></td></tr>
            <tr><td style="padding:6px 0;color:#8b7355">Rubro</td><td>${rubro || '—'}</td></tr>
            <tr><td style="padding:6px 0;color:#8b7355">Dueño</td><td>${dueno || '—'}</td></tr>
            <tr><td style="padding:6px 0;color:#8b7355">Email</td><td>${email}</td></tr>
            <tr><td style="padding:6px 0;color:#8b7355">WhatsApp</td><td>${whatsapp}</td></tr>
            <tr><td style="padding:6px 0;color:#8b7355">Plan</td><td><strong>${NOMBRE_PLAN[plan] || plan}</strong></td></tr>
            <tr><td style="padding:6px 0;color:#8b7355">Estado</td><td>⏳ Pendiente de pago en MP</td></tr>
          </table>
          <p style="margin-top:20px;color:#8b7355;font-size:0.85rem">ID registro: ${registroId}</p>
        </div>
      `,
    })
    console.log('[email] Notificación enviada a Ivan')
  } catch (err) {
    console.error('[email] Error notificando registro:', err)
  }
}

// ─────────────────────────────────────────────────────────────────────
//  GET /health
// ─────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() })
})

// ─────────────────────────────────────────────────────────────────────
//  POST /registro
//  Cuerpo: { nombre, rubro, dueno, email, whatsapp, plan }
//  1. Guarda en platform/registros/{id}
//  2. Devuelve la URL de suscripción del plan elegido
// ─────────────────────────────────────────────────────────────────────
app.post('/registro', async (req, res) => {
  const { nombre, rubro, dueno, email, whatsapp, plan } = req.body || {}
  if (!nombre || !email || !plan) {
    return res.status(400).json({ error: 'Faltan campos obligatorios: nombre, email, plan.' })
  }

  try {
    // ── Obtener el plan de MP guardado en Firestore
    const planDoc = await db.collection('platform').doc('planes').get()
    const planes  = planDoc.exists ? planDoc.data() : {}
    const planId  = planes[plan]

    if (!planId) {
      return res.status(400).json({
        error: `Plan "${plan}" no encontrado. Ejecutá /setup/crear-planes primero.`,
      })
    }

    // ── Guardar solicitud en Firestore
    const ref = db.collection('platform').doc('registros').collection('items').doc()
    const registro = {
      nombre,
      rubro:     rubro || '',
      dueno:     dueno || '',
      email,
      whatsapp:  whatsapp || '',
      plan,
      planMpId:  planId,
      estado:    'pendiente_pago',
      creadoEn:  admin.firestore.FieldValue.serverTimestamp(),
    }
    await ref.set(registro)

    // ── Construir URL de suscripción MP
    //    El external_reference lo armamos con registroId para reconocerlo en el webhook
    const registroId = ref.id
    const mpPlan     = new PreApprovalPlan(mp)
    const planData   = await mpPlan.get({ preApprovalPlanId: planId })

    // La URL de suscripción pública del plan
    const init_url = planData.init_point || planData.collector_info?.register_idempotency_key
      ? `https://www.mercadopago.com.pe/subscriptions/checkout?preapproval_plan_id=${planId}&external_reference=${registroId}&payer_email=${encodeURIComponent(email)}`
      : `https://www.mercadopago.com.pe/subscriptions/checkout?preapproval_plan_id=${planId}`

    const urlSuscripcion = `https://www.mercadopago.com.pe/subscriptions/checkout?preapproval_plan_id=${planId}&external_reference=${registroId}&payer_email=${encodeURIComponent(email)}`

    // Actualizamos el registro con su propio ID y la URL generada
    await ref.update({ registroId, urlSuscripcion })

    // Notificar a Ivan por email (no bloqueante)
    notificarRegistroNuevo({ nombre, rubro, dueno, email, whatsapp, plan, registroId })

    res.json({ ok: true, registroId, urlSuscripcion })
  } catch (err) {
    console.error('[/registro] Error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────
//  POST /webhook/suscripcion
//  MercadoPago llama aquí cuando cambia el estado de una suscripción.
//  Docs: https://www.mercadopago.com.ar/developers/es/docs/subscriptions/additional-content/notifications
// ─────────────────────────────────────────────────────────────────────
app.post('/webhook/suscripcion', async (req, res) => {
  // Responder 200 DE INMEDIATO – MP reintenta si no recibe respuesta rápida
  res.sendStatus(200)

  const { type, data } = req.body || {}
  console.log('[webhook/suscripcion] type:', type, 'id:', data?.id)

  if (type !== 'subscription_preapproval') return

  try {
    const preApproval = new PreApproval(mp)
    const sub = await preApproval.get({ id: data.id })

    console.log('[webhook/suscripcion] status:', sub.status, 'external_ref:', sub.external_reference)

    // external_reference = registroId guardado en /registro
    const registroId = sub.external_reference
    if (!registroId) {
      console.warn('[webhook/suscripcion] Sin external_reference, ignorando.')
      return
    }

    const registroRef = db
      .collection('platform').doc('registros')
      .collection('items').doc(registroId)
    const registroSnap = await registroRef.get()

    if (!registroSnap.exists) {
      console.warn('[webhook/suscripcion] Registro no encontrado:', registroId)
      return
    }

    const registro = registroSnap.data()

    if (sub.status === 'authorized') {
      // ── Suscripción activa: activar o crear el negocio en Firestore
      await activarNegocio({ registro, registroId, sub })
    } else if (['cancelled', 'paused'].includes(sub.status)) {
      // ── Suscripción cancelada o pausada: desactivar negocio
      if (registro.businessId) {
        await db.collection('businesses').doc(registro.businessId).update({
          activo:                         false,
          'suscripcion.estado':           sub.status,
          'suscripcion.actualizadoEn':    admin.firestore.FieldValue.serverTimestamp(),
        })
        console.log('[webhook] Negocio desactivado:', registro.businessId)
      }
      await registroRef.update({ estado: sub.status })
    }
  } catch (err) {
    console.error('[webhook/suscripcion] Error:', err)
  }
})

// ── Helper: crear / activar negocio en Firestore ──────────────────────
async function activarNegocio({ registro, registroId, sub }) {
  const registroRef = db
    .collection('platform').doc('registros')
    .collection('items').doc(registroId)

  let businessId = registro.businessId

  if (!businessId) {
    // Generar ID a partir del nombre del negocio (slug simple)
    businessId = registro.nombre
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // quitar tildes
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .substring(0, 30)

    // Si ya existe ese ID, le agregamos sufijo numérico
    const existe = await db.collection('businesses').doc(businessId).get()
    if (existe.exists) businessId = `${businessId}-${Date.now().toString(36)}`
  }

  const ahora = admin.firestore.FieldValue.serverTimestamp()

  await db.collection('businesses').doc(businessId).set({
    id:           businessId,
    nombre:       registro.nombre,
    rubro:        registro.rubro || '',
    adminEmails:  [registro.email],
    whatsapp:     registro.whatsapp || '',
    activo:       true,
    plan:         registro.plan,
    suscripcion: {
      mpId:         sub.id,
      planMpId:     sub.preapproval_plan_id,
      estado:       'activo',
      creadoEn:     ahora,
      actualizadoEn: ahora,
    },
    creadoEn: ahora,
  }, { merge: true })

  await registroRef.update({
    estado:     'activo',
    businessId,
    activadoEn: ahora,
  })

  // Índice email → businessId para el login centralizado
  // Clave: email con @ y . reemplazados para ser doc ID válido
  const emailKey = registro.email.replace(/[.@]/g, '_')
  await db.collection('platform').doc('userBusinessMap')
    .collection('byEmail').doc(emailKey).set({
      businessId,
      email: registro.email,
    })

  console.log('[activarNegocio] Negocio activado:', businessId)

  // Email de bienvenida al nuevo negocio (no bloqueante)
  enviarEmailBienvenida({
    nombre:     registro.nombre,
    email:      registro.email,
    plan:       registro.plan,
    businessId,
  })
}

// ─────────────────────────────────────────────────────────────────────
//  POST /webhook/pago
//  Notificaciones de pagos únicos (tarjeta, no suscripción)
// ─────────────────────────────────────────────────────────────────────
app.post('/webhook/pago', async (req, res) => {
  res.sendStatus(200)
  const { type, data } = req.body || {}
  console.log('[webhook/pago] type:', type, 'id:', data?.id)
  // Por ahora solo logueamos. Implementar según necesidad.
})

// ─────────────────────────────────────────────────────────────────────
//  POST /crear-preferencia
//  Cuerpo: { items: [{ title, unit_price, quantity }], businessId }
//  Crea una preferencia de pago MP para tarjeta y devuelve init_point
// ─────────────────────────────────────────────────────────────────────
app.post('/crear-preferencia', async (req, res) => {
  const { items, businessId } = req.body || {}
  if (!items?.length || !businessId) {
    return res.status(400).json({ error: 'Faltan items o businessId.' })
  }
  try {
    const pref = new Preference(mp)
    const result = await pref.create({
      body: {
        items,
        back_urls: {
          success: `https://${businessId}.lealteck.com/pago-exitoso`,
          failure: `https://${businessId}.lealteck.com/pago-fallido`,
          pending: `https://${businessId}.lealteck.com/pago-pendiente`,
        },
        auto_return:      'approved',
        notification_url: `${process.env.SERVER_URL}/webhook/pago`,
      },
    })
    res.json({ init_point: result.init_point, id: result.id })
  } catch (err) {
    console.error('[/crear-preferencia] Error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────
//  POST /setup/crear-planes   (llamar UNA sola vez después del deploy)
//  Crea los 3 planes de suscripción en MP y guarda sus IDs en Firestore
// ─────────────────────────────────────────────────────────────────────
app.post('/setup/crear-planes', async (req, res) => {
  // Protección mínima: requiere el mismo Access Token como header
  const auth = req.headers['x-admin-token']
  if (auth !== process.env.MP_ACCESS_TOKEN) {
    return res.status(401).json({ error: 'No autorizado.' })
  }

  try {
    const mpPlan = new PreApprovalPlan(mp)
    const resultados = {}

    for (const config of PLANES_CONFIG) {
      const { key, ...body } = config
      const plan = await mpPlan.create({ body })
      resultados[key] = plan.id
      console.log(`[setup] Plan "${key}" creado: ${plan.id}`)
    }

    // Guardar IDs en Firestore para usarlos en /registro
    await db.collection('platform').doc('planes').set(resultados, { merge: true })

    res.json({ ok: true, planes: resultados })
  } catch (err) {
    console.error('[/setup/crear-planes] Error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────
//  GET /planes
//  Devuelve los IDs de los planes guardados en Firestore
// ─────────────────────────────────────────────────────────────────────
app.get('/planes', async (_req, res) => {
  try {
    const snap = await db.collection('platform').doc('planes').get()
    if (!snap.exists) return res.json({ planes: null, mensaje: 'Ejecutá /setup/crear-planes primero.' })
    res.json({ planes: snap.data() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────
//  POST /cancelar-suscripcion
//  El dueño del negocio cancela su suscripción desde su panel.
//  Header: Authorization: Bearer <firebase-id-token>
//  Cuerpo: { businessId }
// ─────────────────────────────────────────────────────────────────────
app.post('/cancelar-suscripcion', async (req, res) => {
  // Verificar Firebase ID token
  const authHeader = req.headers['authorization'] || ''
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!idToken) return res.status(401).json({ error: 'Token requerido.' })

  let decoded
  try {
    decoded = await admin.auth().verifyIdToken(idToken)
  } catch {
    return res.status(401).json({ error: 'Token inválido.' })
  }

  const { businessId } = req.body || {}
  if (!businessId) return res.status(400).json({ error: 'Falta businessId.' })

  try {
    // Verificar que el email del token es admin del negocio
    const bizSnap = await db.collection('businesses').doc(businessId).get()
    if (!bizSnap.exists) return res.status(404).json({ error: 'Negocio no encontrado.' })

    const biz = bizSnap.data()
    if (!biz.adminEmails?.includes(decoded.email)) {
      return res.status(403).json({ error: 'No tenés permiso para cancelar este negocio.' })
    }

    const mpId = biz.suscripcion?.mpId
    if (!mpId) return res.status(400).json({ error: 'No se encontró la suscripción en MercadoPago.' })

    // Cancelar en MercadoPago
    const preApproval = new PreApproval(mp)
    await preApproval.update({ id: mpId, body: { status: 'cancelled' } })

    // Actualizar Firestore
    const ahora = admin.firestore.FieldValue.serverTimestamp()
    await db.collection('businesses').doc(businessId).update({
      activo: false,
      'suscripcion.estado': 'cancelada',
      'suscripcion.actualizadoEn': ahora,
    })

    // Actualizar privado/suscripcion si existe
    try {
      await db.collection('businesses').doc(businessId)
        .collection('privado').doc('suscripcion').update({
          estado: 'cancelada', actualizadoEn: ahora,
        })
    } catch { /* puede no existir */ }

    console.log('[cancelar-suscripcion] Cancelado:', businessId)
    res.json({ ok: true })
  } catch (err) {
    console.error('[/cancelar-suscripcion] Error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────
//  POST /admin/linkear-negocio
//  Crea manualmente la entrada userBusinessMap para negocios existentes
//  Cuerpo: { email, businessId }
//  Header: x-admin-token: <MP_ACCESS_TOKEN>
// ─────────────────────────────────────────────────────────────────────
app.post('/admin/linkear-negocio', async (req, res) => {
  const auth = req.headers['x-admin-token']
  if (auth !== process.env.MP_ACCESS_TOKEN) {
    return res.status(401).json({ error: 'No autorizado.' })
  }

  const { email, businessId } = req.body || {}
  if (!email || !businessId) {
    return res.status(400).json({ error: 'Faltan email y/o businessId.' })
  }

  try {
    const emailKey = email.replace(/[.@]/g, '_')
    await db.collection('platform').doc('userBusinessMap')
      .collection('byEmail').doc(emailKey).set({ businessId, email })

    console.log(`[linkear-negocio] ${email} → ${businessId}`)
    res.json({ ok: true, emailKey, businessId })
  } catch (err) {
    console.error('[/admin/linkear-negocio] Error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Arranque ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`✅ Lealteck server corriendo en puerto ${PORT}`)
})
