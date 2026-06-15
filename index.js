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
      free_trial: { frequency: 15, frequency_type: 'days' },
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
      free_trial: { frequency: 15, frequency_type: 'days' },
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
      free_trial: { frequency: 15, frequency_type: 'days' },
    },
    back_url: 'https://lealteck.com/gracias',
  },
]

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

    // Actualizamos el registro con su propio ID y la URL generada
    await ref.update({ registroId, urlSuscripcion: init_url })

    res.json({
      ok:          true,
      registroId,
      urlSuscripcion: `https://www.mercadopago.com.pe/subscriptions/checkout?preapproval_plan_id=${planId}&external_reference=${registroId}&payer_email=${encodeURIComponent(email)}`,
    })
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

  console.log('[activarNegocio] Negocio activado:', businessId)
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

// ── Arranque ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`✅ Lealteck server corriendo en puerto ${PORT}`)
})
