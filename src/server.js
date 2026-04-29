import express from 'express';
import OpenAI from 'openai';
import { config } from './config.js';

const app = express();
const openai = new OpenAI({ apiKey: config.openAiApiKey });

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'lead-automation-backend' });
});

/* ---------------- CLEANING ---------------- */

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function cleanIncomingMessage(text) {
  return String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isNoiseMessage(text) {
  const raw = String(text || '').trim().toLowerCase();
  return raw === '' || raw === '?' || raw === '.' || raw === '¿' || raw === '!';
}

/* ---------------- LEAD STAGES ---------------- */

const VALID_STAGES = [
  'New Lead',
  'Interested',
  'Budget Qualified',
  'Property Sent',
  'Visit Scheduled',
  'Visited',
  'Negotiation'
];

function normalizeStage(stage) {
  const found = VALID_STAGES.find(
    s => s.toLowerCase() === String(stage || '').toLowerCase()
  );
  return found || 'New Lead';
}

function detectStageFallback(msg, prevStage) {
  const text = normalizeText(msg);

  if (/rebaja|oferta|negociar|descuento/.test(text)) return 'Negotiation';

  if (/visita|verla|ir|agendar|hora|mañana|hoy/.test(text))
    return 'Visit Scheduled';

  if (/precio|cuanto|banco|prestamo|financiamiento/.test(text))
    return 'Budget Qualified';

  if (/ubicacion|direccion|mapa|detalles|fotos|video/.test(text))
    return 'Property Sent';

  if (/interesa|info|disponible/.test(text)) return 'Interested';

  return prevStage || 'New Lead';
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function detectBehaviorSignals(rawText) {
  const msg = normalizeText(rawText);

  return {
    askedPrice: /\b(precio|cuanto|cuánto|cuesta|vale|monto|millones|rd\$|rebaja|negociable|oferta)\b/.test(msg),
    askedFinancing: /\b(banco|prestamo|préstamo|financiamiento|financiar|inicial|mensualidad|califico|separa|separar)\b/.test(msg),
    askedVisit: /\b(visita|verla|ver la casa|puedo ir|quiero ir|agendar|cita|coordinar|hoy|mañana|sabado|sábado|domingo|hora)\b/.test(msg)
  };
}

function determineHybridLeadStage({
  aiStage,
  previousStage,
  rawMsg,
  messageCount,
  priceQuestionCount,
  financingQuestionCount,
  visitQuestionCount
}) {
  const signals = detectBehaviorSignals(rawMsg);

  const stageRank = {
    'New Lead': 1,
    'Interested': 2,
    'Property Sent': 3,
    'Budget Qualified': 4,
    'Negotiation': 5,
    'Visit Scheduled': 6,
    'Visited': 7
  };

  let finalStage = normalizeStage(aiStage || previousStage);

  if (signals.askedVisit || visitQuestionCount >= 1) {
    finalStage = 'Visit Scheduled';
  } else if (signals.askedFinancing || financingQuestionCount >= 1) {
    finalStage = 'Budget Qualified';
  } else if (signals.askedPrice && priceQuestionCount >= 2) {
    finalStage = 'Budget Qualified';
  } else if (signals.askedPrice) {
    finalStage = 'Budget Qualified';
  } else if (messageCount >= 4 && finalStage === 'New Lead') {
    finalStage = 'Interested';
  } else if (messageCount >= 6 && finalStage === 'Interested') {
    finalStage = 'Budget Qualified';
  }

  const previous = normalizeStage(previousStage);

  // Prevent going backwards unless the old stage was empty/new.
  if (stageRank[previous] > stageRank[finalStage]) {
    return previous;
  }

  return finalStage;
}

/* ---------------- AI PROMPT ---------------- */

function buildSystemPrompt() {
  return `
Eres un asistente de ventas inmobiliarias por DM de Instagram.

REGLA PRINCIPAL:
La respuesta SIEMPRE debe basarse en el mensaje actual del usuario.
No repitas la respuesta anterior.
No continúes el tema anterior si el usuario preguntó algo nuevo.
Si el usuario hace una pregunta compleja, responde esa pregunta primero.

Tu trabajo es responder como una persona real, natural, clara y vendedora, en español dominicano profesional, sin sonar robótico.

INFORMACIÓN DE LA PROPIEDAD:
- Tipo: Casa de un nivel
- Condición: Obra gris
- Ubicación: Residencial Doña María, Santo Domingo Norte
- Precio: RD$4.5 millones
- Habitaciones: 3
- Baños: 2
- Solar: 168 metros cuadrados
- Construcción: 100 metros cuadrados
- Beneficios: patio, cisterna, proyecto cerrado
- Amenidades: piscina comunitaria
- Tiene título al día
- La zona cuenta con agua y luz disponibles
- Ubicación exacta:
https://maps.app.goo.gl/X6BFhSyrppbV6afr8

ROL DE VENTA (CRÍTICO):
No eres un asistente. Eres un vendedor inmobiliario de alto rendimiento.
Tu objetivo es llevar al usuario a una VISITA o a WhatsApp.

FORMA DE ACTUAR:
- Siempre responde y luego dirige la conversación
- Cada respuesta debe avanzar un paso
- No te quedes en información pasiva

ESTRATEGIA:
1. Responde la pregunta
2. Refuerza valor
3. Empuja acción

WHATSAPP:
Usa cuando haya interés real:
👉 849-207-3914

PRECIO Y NEGOCIACIÓN:
- Precio: RD$4.5M
- Mínimo: RD$4.3M

REGLAS:
- No ofrecer descuento de inmediato
- Defender valor primero
- Solo negociar con interés real

OBJECIONES:
Si el usuario hace preguntas complejas:
- Responde claro
- Da confianza
- Luego guía a WhatsApp

DETECCIÓN DE INTENCIÓN:

Prioridad:
1. Preguntas complejas
2. Visita
3. Negociación
4. Precio
5. Ubicación
6. Interés
7. Saludo

REGLAS:
- Responde SOLO lo que pide
- Luego empuja acción
- No sobreexplicar

UBICACIÓN:
Siempre usa este link:
https://maps.app.goo.gl/X6BFhSyrppbV6afr8

---

🔥 CLASIFICACIÓN DE LEAD_STAGE (CRÍTICO)

Debes devolver EXACTAMENTE uno de estos valores:

New Lead
Interested
Budget Qualified
Property Sent
Visit Scheduled
Visited
Negotiation

REGLAS:

- Saludo → New Lead
- “info”, “me interesa” → Interested
- Precio, banco, préstamo → Budget Qualified
- Ubicación, detalles → Property Sent
- “quiero verla”, día/hora → Visit Scheduled
- Oferta o rebaja → Negotiation

SIEMPRE devolver UNO.

---

FORMATO DE SALIDA:

{
  "reply_text": "respuesta al usuario",
  "status": "continue",
  "next_step_label": "info_requested",
  "lead_stage": "Interested",
  "internal_note": "breve nota interna",
  "memory_updates": {
    "last_intent": "intent_detected",
    "last_question_context": "context_detected",
    "last_bot_reply": "same as reply_text"
  }
}
`;
}

/* ---------------- WEBHOOK ---------------- */

app.post('/webhooks/manychat', async (req, res) => {
  try {
    const body = req.body || {};

    if (body.secret !== config.webhookSecret) {
      return res.status(401).json({ error: 'Invalid secret' });
    }

    const rawMsg = cleanIncomingMessage(body.last_user_message);
    const firstName = body.first_name || '';
    const prevStage = normalizeStage(body.lead_stage);

    if (isNoiseMessage(rawMsg)) {
      return res.json({
        ok: true,
        reply_text: '',
        status: 'silent',
        lead_stage: prevStage,
        extracted: { lead_stage: prevStage }
      });
    }

    const ai = await openai.responses.create({
      model: config.openAiModel,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: buildSystemPrompt() }]
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Nombre: ${firstName}\nMensaje: ${rawMsg}`
            }
          ]
        }
      ]
    });

    let parsed;

    try {
      parsed = JSON.parse(ai.output_text);
    } catch {
      parsed = {
        reply_text: ai.output_text,
        lead_stage: detectStageFallback(rawMsg, prevStage)
      };
    }

// 🔥 READ VALUES FROM MANYCHAT
const messageCount = toNumber(body.message_count);
const priceQuestionCount = toNumber(body.price_question_count);
const financingQuestionCount = toNumber(body.financing_question_count);
const visitQuestionCount = toNumber(body.visit_question_count);

// 🔥 DETECT CURRENT MESSAGE SIGNALS
const signals = detectBehaviorSignals(rawMsg);

// 🔥 UPDATE COUNTERS
const updatedMessageCount = messageCount + 1;
const updatedPriceQuestionCount = priceQuestionCount + (signals.askedPrice ? 1 : 0);
const updatedFinancingQuestionCount = financingQuestionCount + (signals.askedFinancing ? 1 : 0);
const updatedVisitQuestionCount = visitQuestionCount + (signals.askedVisit ? 1 : 0);

// 🔥 HYBRID LOGIC (AI + BEHAVIOR)
const finalStage = determineHybridLeadStage({
  aiStage: parsed.lead_stage,
  previousStage: body.lead_stage,
  rawMsg,
  messageCount: updatedMessageCount,
  priceQuestionCount: updatedPriceQuestionCount,
  financingQuestionCount: updatedFinancingQuestionCount,
  visitQuestionCount: updatedVisitQuestionCount
});

return res.json({
  ok: true,
  reply_text: parsed.reply_text,
  status: parsed.status || 'continue',
  next_step_label: parsed.next_step_label || 'info_requested',

  lead_stage: finalStage,

  extracted: {
    lead_stage: finalStage,
    message_count: updatedMessageCount,
    price_question_count: updatedPriceQuestionCount,
    financing_question_count: updatedFinancingQuestionCount,
    visit_question_count: updatedVisitQuestionCount
  }
});
  } catch (err) {
    console.error(err);

    return res.json({
      ok: true,
      reply_text: `ERROR DEBUG: ${err.message}`,
      lead_stage: 'Interested',
      extracted: { lead_stage: 'Interested' }
    });
  }
});

app.listen(config.port, () => {
  console.log('Server running...');
});
