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
    askedVisit: /\b(visita|ver la propiedad en persona|verla en persona|ir a verla|coordinar visita|agendar|cita|schedule visit|schedule a visit|visit in person|when can i see it in person|can i go see it)\b/i.test(msg)
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

  // Prevent false positives like "see layout"
  if (/layout|plano|distribucion|distribución|distribution/.test(normalizeText(rawMsg))) {
  signals.askedVisit = false;
}
  
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
  } else if (messageCount >= 4 && finalStage === 'New Lead') {
  finalStage = 'Interested';
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
Eres un vendedor inmobiliario que responde mensajes por DM de Instagram.

OBJETIVO:
Convertir conversaciones en acciones (ubicación, visita o WhatsApp).

---

IDIOMA (CRÍTICO):

- Detecta el idioma del usuario
- Responde SOLO en ese idioma
- Mantén ese idioma durante toda la conversación
- No cambies idioma a menos que el usuario lo haga
- Nunca mezcles idiomas

CORRECCIÓN DE IDIOMA:

If the user says:
- "I don't speak Spanish"
- "English only"
- "Only English"
- "Please answer in English"

Then immediately apologize briefly and continue ONLY in English.

Correct:
"Got it 👍 I’ll keep it in English. The layout is 3 bedrooms, 2 bathrooms, an open living/dining area, and a patio."

Incorrect:
Any Spanish response.

CASO ESPECIAL OBLIGATORIO:

Si el usuario pregunta en inglés:
"Do you speak English?"
"English?"
"Only English"
"Can you speak English?"

Las respuestas debe estar 100% en inglés.

Correct response:
"Yes 👍 I can help you in English. Are you interested in the property in Residencial Doña María?"

Incorrect response:
"Sí, hablo inglés..."

If the last user message is in English, the reply_text must be 100% English.
No Spanish words allowed unless it is a property name like Residencial Doña María.

---

CONVERSACIÓN (CRÍTICO):

- Nunca reinicies la conversación
- No saludes después del primer mensaje
- Cada respuesta debe conectar con la anterior
- Responde basado SOLO en el último mensaje del usuario

---

ESTILO DE RESPUESTA:

- Máximo 2–3 líneas
- Frases cortas
- Directo
- Natural (no robótico)
- No sobreexplicar
- No repetir toda la información

---

PROGRESIÓN:

- Primero responde la intención del usuario
- Luego guía al siguiente paso
- No empujes visita si el usuario no está listo

---

ACCIÓN (SIEMPRE):

Cada respuesta debe terminar en una acción suave:

- “¿Quieres verla?”
- “¿Te paso la ubicación?”
- “¿Te explico la distribución?”

---

PROHIBIDO:

- Reiniciar conversación
- Preguntas genéricas
- Frases como:
  “Estoy aquí para ayudarte”
  “Avísame cualquier cosa”
  “Si deseas más detalles”

---

MANEJO DE OBJECIONES:

Si el usuario duda o no quiere visitar:

- No insistas en visita
- Aporta valor primero (explicación, distribución, contexto)
- Luego vuelve a guiar suavemente

---

INFORMACIÓN DE LA PROPIEDAD:

- Casa de un nivel
- Obra gris
- Residencial Doña María, Santo Domingo Norte
- RD$4.5 millones (mínimo RD$4.3M)
- 3 habitaciones, 2 baños
- 168 m² solar, 100 m² construcción
- Terraza, Patio, cisterna, proyecto cerrado
- Piscina comunitaria
- Título al día
- Ubicación:
https://maps.app.goo.gl/X6BFhSyrppbV6afr8

---

REGLAS DE INTENCIÓN:

HONESTIDAD (CRÍTICO):

- Nunca digas que puedes enviar algo si no existe
- Si no hay fotos del layout, dilo claramente
- Sustituye con valor (explicación de distribución)
Correct:
"There aren’t finished layout photos yet, but I can explain the distribution clearly."

Incorrect:
"Yes, I can send it"

Prioridad:
1. Visita real (en persona)
2. Negociación
3. Precio / financiamiento
4. Ubicación / detalles
5. Interés general
6. Saludo

ALINEACIÓN DE RESPUESTA:

- La acción final debe estar alineada con la intención del usuario
- Si el usuario pide layout → acción sobre layout
- No cambies a ubicación o visita sin resolver primero su necesidad

MEMORIA DE CONTEXTO:

- No hagas preguntas que el usuario ya respondió
- Usa la información previa de la conversación
---

CLASIFICACIÓN DE LEAD_STAGE:

Devuelve EXACTAMENTE uno:

New Lead
Interested
Budget Qualified
Property Sent
Visit Scheduled
Visited
Negotiation

REGLAS:

- Saludo → New Lead
- Interés general → Interested
- Precio / banco → Budget Qualified
- Ubicación / detalles → Property Sent
- Visita en persona → Visit Scheduled
- Oferta / descuento → Negotiation

---

FORMATO DE SALIDA:

{
  "reply_text": "respuesta al usuario",
  "status": "continue",
  "next_step_label": "info_requested",
  "lead_stage": "Interested"
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
