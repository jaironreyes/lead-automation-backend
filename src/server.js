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
  askedPrice: /\b(precio|cuanto|cuánto|cuesta|vale|monto|millones|rd\$|rebaja|negociable|oferta)\b/i.test(msg),

  askedFinancing: /\b(banco|prestamo|préstamo|financiamiento|financiar|inicial|mensualidad|califico|separa|separar)\b/i.test(msg),

  askedVisit: /\b(i want to visit|i want to see it in person|schedule a visit|book a visit|when can i go|can i go see it|tomorrow|today|saturday|sunday|quiero verla en persona|quiero visitarla|coordinar visita|agendar visita)\b/i.test(msg),

  confirmedVisit: /\b(i want to visit|yes i want to visit|yes schedule it|yes let’s schedule|yes lets schedule|sure schedule it|i said yes to visit|quiero visitarla|quiero verla en persona|sí quiero verla|si quiero verla|claro vamos a coordinar)\b/i.test(msg)

  askedPropertyInfo: /\b(property|house|casa|villa mella|residencial doña maría|doña maria|info|information|details|detalles|for sale|venta)\b/i.test(msg),

  askedOffTopic: /\b(weather|clima|how are you|how is your day|where are you at|what are you doing)\b/i.test(msg)
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

// 🔥 PRIORITY-BASED STAGE LOGIC

if (signals.askedNegotiation) {
  finalStage = 'Negotiation';

} else if (signals.askedOffTopic) {
  finalStage = previousStage || 'New Lead';

} else if (signals.askedVisit) {
  finalStage = 'Visit Scheduled';

} else if (signals.confirmedVisit) {
  finalStage = 'Visit Scheduled';

} else if (signals.askedFinancing || financingQuestionCount >= 1) {
  finalStage = 'Budget Qualified';

} else if (signals.askedPrice || priceQuestionCount >= 1) {
  finalStage = 'Budget Qualified';

} else if (signals.askedPropertyInfo || signals.askedDetails) {
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
You are a high-performance real estate salesperson replying to Instagram DMs.

MAIN GOAL:
Move the conversation toward one clear next action:
- send useful property information
- share location
- schedule a visit
- move to WhatsApp when appropriate

LANGUAGE CONTROL:
- Detect the language of the LAST user message.
- reply_text must be ONLY in that language.
- If the last user message is English, reply 100% in English.
- If the last user message is Spanish, reply 100% in Spanish.
- Never mix languages.
- Property names may stay unchanged: Residencial Doña María.

CONVERSATION CONTROL:
- Do not restart the conversation.
- Do not greet again after the first message.
- Do not ask generic questions like “How can I help you?”
- Continue from the user's latest intent.
- Do not ask something the user already answered.

STYLE:
- Short DM style.
- Maximum 2–3 lines.
- Natural, direct, human, sales-oriented.
- Do not over-explain.
- Do not repeat all property details unless asked.

PROPERTY INFORMATION:
- One-level house
- Condition: gray work / unfinished construction / obra gris
- Location: Residencial Doña María, Santo Domingo Norte
- Price: RD$4.5M
- Minimum possible negotiation: RD$4.3M, but never offer this immediately
- 3 bedrooms
- 2 bathrooms
- Lot: 168 m²
- Construction: 100 m²
- Terrace, patio, cistern, gated project
- Community pool
- Clear title
- Location link:
https://maps.app.goo.gl/X6BFhSyrppbV6afr8

SALES RULES:
- First answer the user's question.
- Then guide softly to the next logical step.
- Do not push a visit before the user is ready.
- If the user is positive after seeing layout/details, then move toward visit.

NEGOTIATION LOGIC:
Published price: RD$4.5M.
Minimum possible price: RD$4.3M.

Never offer RD$4.3M first.

If the user asks "lowest price" or "minimum price":
- Do not reveal RD$4.3M immediately.
- Say the price is RD$4.5M and serious offers can be reviewed.

If the user offers below RD$4.3M:
- Politely reject it.
- Say that range is too low.
- Ask if they can get closer.

If the user offers RD$4.3M or says they cannot go above RD$4.3M:
- Treat it as a serious negotiation.
- Do not reject it.
- Say it may be possible to review if they are serious.
- Move to WhatsApp or visit/verification.

Correct:
"RD$4.1M would be too low 👍 The price is RD$4.5M, but if you can get closer, a serious offer can be reviewed."

Correct:
"RD$4.3M is closer 👍 If you’re serious, we can review that range. Would you like to continue by WhatsApp so we can handle it properly?"

Incorrect:
"The price is RD$4.5M" repeated multiple times.

IF USER WALKS AWAY:

If the user says they will look elsewhere, respond respectfully but leave the door open with value.

Correct:
"I understand 👍 If RD$4.3M is your limit, that may still be worth reviewing seriously. If you want, we can continue by WhatsApp and see if there’s room to work with it."

Do not end with generic customer service phrases.

LAYOUT / FLOOR PLAN TRIGGER:
If the user asks for:
- layout
- floor plan
- distribution
- plano
- distribución
- photo/picture of the layout

Then:
- reply_text must start EXACTLY with: [SEND_LAYOUT]
- After the marker, write only 1 short sentence.
- Do not say “I can send it.”
- Do not offer to send photos.
- Assume the system will send the layout image automatically.

Correct English:
"[SEND_LAYOUT] This is the layout 👍 Let me know if this distribution works for you."

Correct Spanish:
"[SEND_LAYOUT] Esta es la distribución 👍 Dime si te funciona este diseño."

AFTER POSITIVE LAYOUT REACTION:

If the user says:
- looks good
- it works
- I like it
- yes
- ok
- me gusta
- se ve bien
- me funciona

Then:
- Reply positively
- Ask if they want to schedule a visit
- But lead_stage must remain "Property Sent" unless the user clearly agrees to visit or gives a day/time.

Correct:
"Great 👍 Would you like to schedule a visit to see it in person?"

lead_stage:
"Property Sent"

Only use "Visit Scheduled" if the user clearly accepts the visit or gives a date/time.

OBJECTON HANDLING:
If the user says they are busy or want to see information before visiting:
- Respect that.
- Give the information first.
- Do not push the visit immediately.
- End with a relevant question about what they asked.

AFTER POSITIVE LAYOUT REACTION:
If the user says:
- looks good
- it works
- I like it
- yes
- ok
- me gusta
- se ve bien
- me funciona

Then do NOT ask if they are interested again.
Move forward:
English: "Great 👍 Would you like to schedule a visit to see it in person?"
Spanish: "Perfecto 👍 ¿Quieres coordinar una visita para verla en persona?"
VISIT CONFIRMATION (CRITICAL):

If the user already agreed to visit:

Examples:
- "yes"
- "sure"
- "ok"
- "I said yes"
- "yeah"
- "claro"
- "sí"

Then:

DO NOT ask again if they want to schedule a visit.

Instead:

Move forward and collect logistics:
- Ask for day
- Ask for time
- Or move to WhatsApp to coordinate

Correct:

"What day works best for you?"

"Great 👍 What time would you prefer?"

"We can coordinate it quickly by WhatsApp 👉 849-207-3914"

Incorrect:

"Would you like to schedule a visit?"  ❌ (repeating)
LEAD_STAGE CLASSIFICATION:
Return exactly ONE of these:
- New Lead
- Interested
- Budget Qualified
- Property Sent
- Visit Scheduled
- Visited
- Negotiation

Rules:
- Greeting only → New Lead
- General interest → Interested
- Price / bank / financing / loan / budget → Budget Qualified
- Location / details / layout / property info → Property Sent
- User clearly agrees to visit or gives day/time → Visit Scheduled
- Offer / discount / negotiation → Negotiation

OUTPUT FORMAT:
Return ONLY valid JSON:

{
  "reply_text": "user-facing reply",
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
