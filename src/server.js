import express from 'express';
import OpenAI from 'openai';
import { config } from './config.js';

const app = express();
const openai = new OpenAI({ apiKey: config.openAiApiKey });

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'lead-automation-backend' });
});

/* ---------------- TEMP BACKEND MEMORY ---------------- */

const conversations = new Map();

function getConversationHistory(userId) {
  return conversations.get(userId) || [];
}

function saveConversationMessage(userId, role, text) {
  if (!userId || !text) return;

  const history = getConversationHistory(userId);

  history.push({
    role,
    text: String(text).slice(0, 500),
    timestamp: new Date().toISOString()
  });

  // Keep only last 12 messages
  conversations.set(userId, history.slice(-12));
}

function formatConversationHistory(userId) {
  const history = getConversationHistory(userId);

  if (!history.length) return 'No previous conversation.';

  return history
    .map(m => `${m.role}: ${m.text}`)
    .join('\n');
}

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

function generateFallbackReply(msg, prevStage) {
  const text = msg.toLowerCase();

if (
  text.includes('financiamiento') ||
  text.includes('financiar') ||
  text.includes('banco') ||
  text.includes('prestamo') ||
  text.includes('préstamo') ||
  text.includes('inicial') ||
  text.includes('mensualidad')
) {
  return 'Sí 👍 se puede evaluar financiamiento con banco. Para una casa de RD$4.5M, un escenario común es preparar alrededor de un 20% de inicial, pero la aprobación final depende del banco y tu perfil. ¿Qué inicial tienes pensado manejar?';
}

if (text.includes('precio') || text.includes('cuesta')) {
  return 'El precio actual es de RD$4.5M 👍 ¿Te gustaría ver opciones de financiamiento o coordinar una visita?';
}

  if (text.includes('foto') || text.includes('ver')) {
    return 'Claro 👍 puedo mostrarte fotos de la propiedad. ¿Quieres ver la distribución, la fachada o las amenidades?';
  }

  if (text.includes('dirección') || text.includes('ubicación')) {
    return 'Está ubicado en Residencial Doña María, Santo Domingo Norte 👍 ¿Te gustaría coordinar una visita para verlo en persona?';
  }

  return 'Perfecto 👍 cuéntame, ¿te gustaría ver más detalles o coordinar una visita?';
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function detectBehaviorSignals(rawText) {
  const msg = normalizeText(rawText);

return {
  // 1. Highest-value conversion signals
  askedWhatsapp: /\b(whatsapp|number|phone|contacto|numero|número)\b/i.test(msg),

  askedNegotiation: /\b(lowest|minimum|offer|discount|negotiate|negotiable|rebaja|oferta|negociar|descuento|precio minimo|precio mínimo|lo menos|take|can you take|i can offer|4\.1|4\.3|millones)\b/i.test(msg),

  gavePriceNumber: /\b(rd\$|dop|millones|millon|millón|precio|oferta|rebaja|negociar|descuento)\b/i.test(msg)
  && /\b([0-9]+(\.[0-9]+)?)\b/i.test(msg),

  // 2. Visit / scheduling signals
  gaveSchedulingTime: /\b([1-9]|1[0-2])(:[0-5][0-9])?\s?(am|pm|a\.m\.|p\.m\.)\b/i.test(msg),

  gaveSchedulingDay: /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\b/i.test(msg),

  askedVisit: /\b(i want to visit|i want to see it in person|schedule a visit|book a visit|when can i go|can i go see it|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|mañana|tarde|quiero verla en persona|quiero visitarla|coordinar visita|agendar visita)\b/i.test(msg),

  confirmedVisit: /\b(sure|yes|yes i want to visit|yes schedule it|yes let’s schedule|yes lets schedule|sure schedule it|i said yes to visit|quiero visitarla|quiero verla en persona|sí quiero verla|si quiero verla|claro vamos a coordinar)\b/i.test(msg),

  askedGeneralAgreement: /\b(looks good|looked good|me gusta|se ve bien|perfecto|nice|great)\b/i.test(msg),

  agreedToNextStep: /\b(let'?s do that|ok let'?s do it|sounds good|perfect|dale|vamos|ok hagamoslo)\b/i.test(msg),

  // 3. Budget signals
  askedPrice: /\b(precio|cuanto|cuánto|cuesta|vale|monto|millones|rd\$|rebaja|negociable|oferta|price|how much)\b/i.test(msg),

  askedFinancing: /\b(banco|prestamo|préstamo|financiamiento|financiar|inicial|mensualidad|califico|separa|separar|bank|loan|financing|down payment|monthly payment)\b/i.test(msg),

  // 4. Interest / property evaluation
  askedGeneralInterest: /\b(interested|i am interested|i want info|tell me more|me interesa|quiero informacion|quiero información|quiero saber más|mas informacion|más información)\b/i.test(msg),

  askedDetails: /\b(layout|floor plan|distribution|plano|distribucion|distribución|patio|terrace|terraza|title|titulo|título|pool|piscina|bedrooms|habitaciones|bathrooms|baños|banos|lot|solar|size|metraje|meters|metros|location|ubicacion|ubicación)\b/i.test(msg),
  askedGeneralDetails: /\b(dame mas detalles|dame más detalles|quiero mas detalles|quiero más detalles|more details|tell me more|mas detalles|más detalles)\b/i.test(msg),

  askedPropertyInfo: /\b(property|house|casa|villa mella|residencial doña maría|doña maria|for sale|venta)\b/i.test(msg),

  // 5. Non-sales / off-topic
  askedOffTopic: /\b(weather|clima|how are you|how is your day|where are you at|what are you doing)\b/i.test(msg),

  askedGreetingOnly: /^(hi|hello|hey|hola|buenas|saludos|saludos otra vez|hello again|buen dia|buen día|good morning|good afternoon)$/i.test(msg),
};
}

function determineHybridLeadStage({
  aiStage,
  prevStage,
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

  const previous = normalizeStage(prevStage);
  let finalStage = normalizeStage(aiStage || prevStage);
  
// 🔥 PRIORITY-BASED STAGE LOGIC
// Negotiation > Visit > Budget > Property > Interested > New Lead

if (signals.askedGreetingOnly) {
  return normalizeStage(prevStage);

} else if (signals.askedNegotiation || signals.gavePriceNumber) {
  let finalStage = normalizeStage(prevStage);

} else if (signals.agreedToNextStep && previous === 'Negotiation') {
  let finalStage = normalizeStage(prevStage);

} else if (signals.askedWhatsapp) {
  finalStage = normalizeStage(prevStage);

} else if (/^\d+(\.\d+)?$/.test(rawMsg.trim())) {
  finalStage = normalizeStage(prevStage);

} else if (signals.askedOffTopic) {
  finalStage = normalizeStage(prevStage);

} else if (
  signals.gaveSchedulingTime ||
  signals.gaveSchedulingDay ||
  signals.askedVisit ||
  signals.confirmedVisit
) {
  finalStage = 'Visit Scheduled';

} else if (signals.askedFinancing || signals.askedPrice) {
  finalStage = 'Budget Qualified';

} else if (signals.askedPropertyInfo || signals.askedDetails) {
  finalStage = 'Property Sent';

} else if (signals.askedGeneralInterest || signals.askedGeneralDetails) {
  finalStage = 'Interested';

} else {
  finalStage = normalizeStage(prevStage);

}


  const stickyStages = ['Negotiation', 'Visit Scheduled'];

if (stickyStages.includes(previous)) {
  // Only allow upward or same-level moves
  if (stageRank[finalStage] < stageRank[previous]) {
    finalStage = previous;
  }
}
// ✅ Real-time intent overrides previous stage
const realtimeOverrideStages = [
  'Negotiation',
  'Budget Qualified',
  'Visit Scheduled',
  'Property Sent',
  'Interested'
];

if (signals.askedGreetingOnly) {
  return 'New Lead';
}

if (realtimeOverrideStages.includes(finalStage)) {
  return finalStage;
}

// ✅ Fallback: keep previous stage if no clear new intent
return previous;
}
/* ---------------- AI PROMPT ---------------- */

function buildSystemPrompt() {
  return `
You are a high-performance real estate salesperson replying to Instagram DMs.

IDENTITY RULE:

If the user asks:
- what is your name
- who are you
- who am I talking to
- como te llamas
- cual es tu nombre

You MUST respond:

"My name is Jairon 😊"

Spanish:
"Mi nombre es Jairon 😊"

IMPORTANT:
- Do NOT say [Your Name]
- Do NOT improvise
- Do NOT add negotiation or sales in this reply
- Keep it short and direct

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

IF USER GOES OFF-TOPIC:
- Politely respond briefly
- Redirect back to the property

Example:
"I can’t help with that, but I’m here for anything about the property 👍"

GREETING RESET RULE:

If the user sends a greeting like:
"hola", "hi", "saludos", "hello again"

Treat it as a soft restart.

DO NOT continue pushing previous step.

Instead:
- Acknowledge greeting
- Re-engage naturally

Example:
"Hola 👋 ¿te gustaría ver más detalles de la casa o coordinar una visita?"

CONVERSATION CONTROL RULE:

If the lead is in a high stage (Visit Scheduled or Negotiation):

- Do NOT restart the funnel.
- Do NOT ask to schedule again.
- Do NOT ask basic qualification questions.

Instead:
- Answer the user’s question directly.
- Continue the conversation from that stage.

Examples:

Negotiation:
User: "¿Cuántos baños tiene?"
→ "Tiene 2 baños 👍. Sobre el precio que comentabas, podemos revisarlo si te acercas un poco más."

Visit Scheduled:
User: "¿Tiene piscina?"
→ "Sí 👍 tiene piscina comunitaria. Ya tienes la visita el martes, ahí podrás verla en persona."

VISIT ALREADY SCHEDULED RULE:

If the previous lead_stage is "Visit Scheduled" and the user asks follow-up questions after scheduling:
- Answer the question directly.
- Do NOT ask again if they want to schedule a visit.
- Do NOT ask what day or time.
- Only remind them briefly that the visit is already coordinated if useful.

Example:
"Sí 👍 el residencial tiene acceso controlado. Ya tienes la visita coordinada para el martes a las 10."

CONTEXT MEMORY (CRITICAL):

Always interpret the user's message together with the immediate previous conversation.

Do NOT treat each message independently.

If the user:
- agrees ("let's do that", "ok", "perfect")
- answers briefly ("tomorrow", "5:30 PM", "right now")
- refers to something ("that", "it")

Then:
- Use the previous bot message to understand what they mean
- Continue that same flow
- Do NOT reset the conversation
- Do NOT ask unrelated questions

Incorrect:
User: "Right now"
Bot: "Could you clarify what you're interested in?"

Correct:
User: "Right now"
Bot: "Perfect 👍 you can message me here: 849-207-3914"

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

FINANCING INFORMATION — DOMINICAN REPUBLIC:

IMPORTANT:
- You are not a bank or loan officer.
- Do NOT guarantee approval, rates, monthly payments, or exact terms.
- Always explain that final approval depends on the bank, income, credit profile, debt level, appraisal, and required documents.
- Keep financing answers short, useful, and sales-oriented.

PROPERTY PRICE:
- Published price: RD$4.5M.
- Estimated buyer should be prepared for an initial payment/down payment.
- In Dominican Republic mortgages, many banks commonly finance around 80% of the property value, depending on approval.
- Buyer may need around 20% initial payment, plus closing/legal/bank expenses.
- For RD$4.5M, 20% initial is approximately RD$900,000.
- Approximate financed amount at 80%: RD$3.6M.
- This is only an estimate. The bank confirms final numbers.

BANKS / FINANCING OPTIONS IN DR:
The buyer may evaluate mortgage financing with banks such as:
- Banco Popular
- Banreservas
- BHD
- Scotiabank
- APAP
- Asociación La Nacional
- Banco Caribe
- Other mortgage institutions depending on profile

BANRESERVAS REFERENCE:
- Banreservas publishes mortgage options where construction/remodeling financing may reach up to 80% of the project budget and terms may go up to 20 years, depending on the product and approval.

GENERAL REQUIREMENTS BUYERS MAY NEED:
- Dominican ID / passport
- Proof of income
- Bank statements
- Credit history
- Employment or business documentation
- Initial payment availability
- Property appraisal
- Clear title / legal property documents

HOW TO ANSWER FINANCING QUESTIONS:

If user asks: “¿Se puede financiar?”
Reply:
"Sí 👍 se puede evaluar financiamiento con banco. Normalmente el banco revisa tus ingresos, crédito e inicial disponible. Para esta casa de RD$4.5M, un escenario común sería preparar alrededor de un 20% de inicial, pero la aprobación final la confirma el banco."

If user asks: “¿Cuánto de inicial?”
Reply:
"Como referencia, muchos bancos pueden pedir alrededor de un 20% de inicial. Para RD$4.5M, eso sería aproximadamente RD$900,000, más gastos de cierre. Pero el monto exacto depende del banco y tu perfil."

If user asks: “¿Cuánto pagaría mensual?”
Reply:
"La mensualidad depende de la tasa, plazo, monto aprobado y tu perfil. Como referencia, se puede calcular con el banco usando el precio de RD$4.5M y el inicial que tengas disponible. ¿Qué inicial tienes pensado manejar?"

If user asks: “¿Qué banco financia?”
Reply:
"Puedes evaluar con bancos como Popular, Banreservas, BHD, APAP, Scotiabank o Asociación La Nacional. Lo ideal es revisar primero tu inicial e ingresos para saber cuál opción te conviene más."

If user asks: “¿Yo califico?”
Reply:
"Eso lo confirma el banco, pero para orientarte mejor: ¿trabajas fijo o independiente, y qué inicial tienes disponible?"

FINANCING SALES RULE:
- After answering financing, ask ONE useful qualification question:
  1. “¿Qué inicial tienes disponible?”
  2. “¿Trabajas fijo o independiente?”
  3. “¿Quieres que coordinemos una visita mientras revisas la parte del banco?”

- Do NOT overload the client with too much banking detail.
- Do NOT sound like a bank officer.
- Keep the goal: qualify budget and move toward visit or WhatsApp.

WINDOW DETAILS (Based on layout distribution):

- Living Room (Sala):
  • 1 large front-facing window (main natural light source)
  • Positioned toward the façade
  • Likely the widest window in the house

- Bedroom 1:
  • 1 window on exterior wall (left side of house)
  • Medium size for ventilation and light

- Bedroom 2:
  • 1 window facing exterior (bottom/terrace side)
  • Medium size

- Bedroom 3:
  • 1 window on right-side exterior wall
  • Medium size

- Kitchen:
  • 1 window above sink area (typical placement)
  • Small to medium size for ventilation

- Bathroom 1:
  • 1 small high-position window (privacy ventilation)

- Bathroom 2:
  • 1 small high-position window (privacy ventilation)

- Total Windows:
  • Approx. 7 windows across the house

GENERAL CHARACTERISTICS:
- All rooms have direct natural ventilation (no interior-only rooms)
- Windows are distributed on all exterior-facing walls
- Designed for cross ventilation (important in DR climate)
- Bathrooms use smaller elevated windows for privacy

AVAILABLE PROPERTY IMAGES / MEDIA:

CEILING HEIGHT:
- Clear ceiling height: 2.6 meters

IMPLICATIONS:
- Good vertical space (comfortable, not low)
- Better air circulation for tropical climate
- Allows standard ceiling fans and recessed lighting comfortably
- Feels open without increasing construction cost

WINDOW + HEIGHT RELATION:
- Living room window likely taller/wider to maximize light at 2.6 m height
- Bedrooms: mid-height windows aligned with wall proportions
- Bathrooms: smaller, high-position windows for privacy
- Layout supports cross ventilation (air flows across rooms at this height)

The system can automatically send these images when relevant:

1. layout
- Floor plan / plano / distribución
- Use when user asks about layout, floor plan, rooms distribution, how the house is inside.

2. entrance
- Entrance / front / façade / access / gated project
- Use when user asks about the entrance, front, outside, exterior, access, security, or how the project looks.

3. pool
- Community pool / amenities
- Use when user asks about the pool, amenities, common areas, or project benefits.

4. render
- Finished-house vision / final look
- Use when user asks how the house could look finished, render, final version, or transformation.

IMPORTANT:
- Do NOT say “I cannot send photos.”
- If the user asks for one of these images, answer naturally as if the system will send it.
- Keep the reply short.
- Mention what image they are about to see.

MEDIA INTENT CLASSIFICATION:

You MUST always return a media_intent value.

Allowed values:
- none
- layout
- entrance
- pool
- render
- fotos

Rules:
- layout → plano, distribución, floor plan
- entrance → entrada, fachada, exterior, acceso, seguridad
- pool → piscina, amenidades
- render → versión terminada, cómo quedaría
- fotos → request for general photos, images, “show me everything”
- none → no image requested

Always include media_intent in JSON.

Correct:
“Claro 👍 aquí tienes la piscina comunitaria del proyecto.”

Correct:
“Sure 👍 this is the layout so you can see the distribution.”

Incorrect:
“I can’t send pictures.”
“I don’t have photos.”

MEDIA RESPONSE RULE:

If the user asks for an available image:
- Respond naturally.
- Do not apologize.
- Do not say you cannot send it.
- Do not ask if they want it after they already asked.
- The backend will set media_intent and ManyChat will send the image.

Examples:
Pool:
“Claro 👍 esta es la piscina comunitaria del proyecto.”

Entrance:
“Claro 👍 esta es la entrada del residencial.”

Layout:
“Claro 👍 esta es la distribución de la casa.”

Render:
“Claro 👍 así puede verse terminada.”

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
- After the marker, write only 1 short sentence.
- Do not say “I can send it.”
- Do not offer to send photos.
- Assume the system will send the layout image automatically.

Correct English:
"This is the layout 👍 Let me know if this distribution works for you."

Correct Spanish:
"Esta es la distribución 👍 Dime si te funciona este diseño."

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

SCHEDULING CONTEXT:

If the previous bot message asked for a day or time, interpret the user's next short answer as scheduling information.

Examples:
- "Tomorrow" = day for visit
- "Monday afternoon" = day/time preference
- "5:30 PM" = time for visit
- "Can you?" = asking if that time works

Do not ask again for information the user already gave.

If the user gives both day and time:
Confirm clearly.

Correct:
"Perfect 👍 Tomorrow at 5:30 PM works as the visit request. I’ll coordinate the details."

Incorrect:
"What day works best for you?"
"What time would you prefer?"
"Could you clarify what you're interested in?"

LEAD STAGE CLASSIFICATION (CRITICAL)

Always return EXACTLY one:

New Lead
Interested
Budget Qualified
Property Sent
Visit Scheduled
Visited
Negotiation

---

PRIORITY ORDER (TOP → BOTTOM):

1. Negotiation
2. Visit Scheduled
3. Budget Qualified
4. Property Sent
5. Interested
6. New Lead

Always choose the HIGHEST matching stage.

---

1. NEW LEAD (GREETING / NO INTENT)

If the user ONLY sends a greeting or casual message:

Examples:
- Hi
- Hello
- Good morning
- Buenas
- Hola
- How are you?
- I’m good

Then:
lead_stage = "New Lead"

IMPORTANT:
- Do NOT classify as Interested
- Do NOT upgrade stage

---

2. INTERESTED (GENERAL INTEREST)

If the user shows general curiosity but no specific intent:

Examples:
- I want info
- Tell me about the house
- I’m interested

Then:
lead_stage = "Interested"

---

3. PROPERTY SENT (EVALUATION STAGE)

If the user asks about property details or is evaluating:

Examples:
- Layout / plano / distribución
- Location / ubicación
- Patio / rooms / size / title
- “Can I see the layout?”
- “Does it have a patio?”

Then:
lead_stage = "Property Sent"

---

4. BUDGET QUALIFIED (MONEY AWARENESS)

If the user asks about money or financing:

Examples:
- Price
- Loan / bank / financing
- Monthly payments
- Down payment

Then:
lead_stage = "Budget Qualified"

---

5. VISIT SCHEDULED (STRONG INTENT)

ONLY if the user clearly agrees to visit OR provides scheduling intent:

Examples:
- I want to visit
- When can I go?
- Tomorrow works
- Saturday at 3

IMPORTANT:
- “Yes”, “Ok”, “Nice”, “Looks good” → NOT enough
- Must be explicit visit intent

Then:
lead_stage = "Visit Scheduled"

WHATSAPP / ACTION CONTEXT (CRÍTICO):

If the user agrees to a previous suggestion ("let's do that", "ok", "perfect"):
- Continue the previous action
- Do NOT change topic
- Do NOT ask new unrelated questions

If the user asks for WhatsApp, phone, or contact:
- Immediately provide the number
- Do NOT ask anything else first

If the user says "right now":
- Treat it as urgency
- Move forward with the current action

Incorrect:
"What day works best for you?"
"Could you clarify what you're interested in?"

Correct:
"Perfect 👍 you can message me here: 849-207-3914"
---

6. NEGOTIATION (PRICE PUSHING)

If the user negotiates or makes an offer:

Examples:
- What’s the lowest?
- Can you lower the price?
- I offer 4.1M
- Discount?

Then:
lead_stage = "Negotiation"

---

RULES:

- NEVER upgrade based on message count alone
- NEVER downgrade stages
- If unclear → keep previous stage
- Always prioritize strongest intent
- If the user is continuing a previous step (visit, WhatsApp, negotiation),
  DO NOT reclassify the stage based only on the last message.
  Maintain or upgrade the stage.

DELAY RULE:

You MUST return delay_seconds from 2 to 10.

Use:
- 2 to 4 for greetings or simple replies
- 5 to 7 for normal property questions
- 8 to 10 for price, visit, media, or negotiation replies

Always include delay_seconds in JSON.

OUTPUT FORMAT:
Return ONLY valid JSON:

{
  "reply_text": "user-facing reply",
  "status": "continue",
  "next_step_label": "info_requested",
  "lead_stage": "Interested",
  "media_intent": "none",
  "delay_seconds": 5
}
`;
}

/* ---------------- WEBHOOK ---------------- */

app.post('/webhooks/manychat', async (req, res) => {
  const startTime = Date.now();
  const body = req.body || {};
  console.log("----- NEW REQUEST -----");
  console.log("Incoming message:", body.last_user_message);
  console.log("Lead stage:", body.lead_stage);

  try {
    const previousBotReply = body.ai_reply || '';
    const userMsg1 = String(body.user_msg_1 || '').slice(0, 300);
    const botReply1 = String(body.bot_reply_1 || '').slice(0, 300);
    const userMsg2 = String(body.user_msg_2 || '').slice(0, 300);
    const botReply2 = String(body.bot_reply_2 || '').slice(0, 300);
    
    if (body.secret !== config.webhookSecret) {
      return res.status(401).json({ error: 'Invalid secret' });
    }

  const rawMsg = cleanIncomingMessage(body.last_user_message);
  const firstName = body.first_name || '';
  const prevStage = normalizeStage(body.lead_stage);
  const userId = String(body.user_id || body.contact_id || firstName || 'unknown');
  const recentConversation = formatConversationHistory(userId);

  const cleanedPreviousBotReply = normalizeText(previousBotReply);
  const cleanedRawPreview = normalizeText(body.last_user_message);

if (
  /ver mas detalles|ver mas detalle|mas detalles|coordinar una visita/.test(cleanedPreviousBotReply) &&
  /^(si|sí|dale|mandamelo|mandamelo|dale mandamelo|ok|claro)$/.test(cleanedRawPreview)
) {
  return res.json({
    ok: true,
    reply_text: 'Claro 👍 La casa está en obra gris, tiene 3 habitaciones, 2 baños, 168 m² de solar, 100 m² de construcción, terraza, patio, cisterna, título claro y piscina comunitaria. El precio es RD$4.5M.',
    status: 'continue',
    next_step_label: 'property_details_sent',
    lead_stage: 'Interested',
    media_intent: 'none',
    delay_seconds: 5,
    extracted: {
      lead_stage: 'Interested',
      media_intent: 'none',
      delay_seconds: 5
    }
  });
}
    
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
          text: `
Nombre: ${firstName}

CRITICAL CURRENT LEAD STAGE:
"${prevStage}"

IMPORTANT:
You MUST respect this stage in your reply.
If stage = "Visit Scheduled":
- The visit is already confirmed
- Do NOT ask to schedule again
- Reinforce the visit naturally when relevant

Recent conversation memory:
${recentConversation}

Current user message:
"${rawMsg}"

Context instruction:
Always combine the user's message with the current lead stage.
Do not ignore the stage.
`
        }
      ]
    }
  ],

  // 🔥 THIS IS THE IMPORTANT PART YOU ARE MISSING
  text: {
    format: {
      type: "json_schema",
      name: "manychat_real_estate_reply",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          reply_text: { type: "string" },
          status: {
            type: "string",
            enum: ["continue", "silent"]
          },
          next_step_label: { type: "string" },
          lead_stage: {
            type: "string",
            enum: [
              "New Lead",
              "Interested",
              "Budget Qualified",
              "Property Sent",
              "Visit Scheduled",
              "Visited",
              "Negotiation"
            ]
          },
          media_intent: {
            type: "string",
            enum: ["none", "layout", "entrance", "pool", "render", "fotos"]
          },
          delay_seconds: {
            type: "number",
            minimum: 2,
            maximum: 10
          }
        },
        required: [
          "reply_text",
          "status",
          "next_step_label",
          "lead_stage",
          "media_intent",
          "delay_seconds"
        ]
      }
    }
  }
});

let parsed;

try {
  const raw = ai.output_text?.trim();

  if (!raw) throw new Error("Empty AI response");

  parsed = JSON.parse(raw);

} catch (parseErr) {
  console.log("⚠️ AI PARSE ERROR:", parseErr.message);
  console.log("⚠️ AI RAW OUTPUT:", ai.output_text);

  // 🔥 SMART FALLBACK (keeps conversation alive)
  parsed = {
    reply_text: generateFallbackReply(rawMsg, prevStage),
    status: 'continue',
    next_step_label: 'fallback',
    lead_stage: detectStageFallback(rawMsg, prevStage),
    media_intent: 'none',
    delay_seconds: 3
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
  prevStage: body.lead_stage,
  rawMsg,
  messageCount: updatedMessageCount,
  priceQuestionCount: updatedPriceQuestionCount,
  financingQuestionCount: updatedFinancingQuestionCount,
  visitQuestionCount: updatedVisitQuestionCount
});

// 🔥 MEDIA INTENT ENGINE (CLEAN)

// 🔥 AI DELAY ENGINE
const delaySeconds = Math.min(
  Math.max(Number(parsed.delay_seconds) || 5, 2),
  10
);
    
const msg = normalizeText(rawMsg);

let mediaIntent = 'none';

// ✅ 1. AI FIRST (PRIMARY SOURCE)
const VALID_MEDIA = ['none', 'layout', 'entrance', 'pool', 'render', 'fotos'];

if (parsed.media_intent && VALID_MEDIA.includes(parsed.media_intent)) {
  mediaIntent = parsed.media_intent;
}

// ✅ 2. FALLBACK (ONLY IF AI FAILS)
else {

  // GENERAL PROJECT PHOTOS
  if (/\b(fotos|photos|pictures|imagenes|imágenes|project photos|fotos del proyecto|barrio|sector)\b/i.test(msg)) {
    mediaIntent = 'fotos';

  // POOL
  } else if (/\b(pool|piscina|amenidades|amenities|area comun|areas comunes)\b/i.test(msg)) {
    mediaIntent = 'pool';

  // ENTRANCE
  } else if (/\b(entrada|frente|fachada|acceso|exterior|outside|entrance|seguridad|porton|proyecto cerrado)\b/i.test(msg)) {
    mediaIntent = 'entrance';

  // LAYOUT
  } else if (/\b(layout|plano|planos|distribucion|distribution|floor plan|habitaciones|cuartos|como es por dentro)\b/i.test(msg)) {
    mediaIntent = 'layout';

  // RENDER
  } else if (/\b(render|terminada|final|como quedaria|como va a quedar|como se veria)\b/i.test(msg)) {
    mediaIntent = 'render';
  }
}
    
saveConversationMessage(userId, 'User', rawMsg);
saveConversationMessage(userId, 'Bot', parsed.reply_text);

console.log("Reply sent:", parsed.reply_text);

const totalTime = Date.now() - startTime;
console.log(`⏱️ Total processing time: ${totalTime} ms`);
    
return res.json({
  ok: true,
  reply_text: parsed.reply_text,
  status: parsed.status || 'continue',
  next_step_label: parsed.next_step_label || 'info_requested',

  lead_stage: finalStage,
  media_intent: mediaIntent,
  delay_seconds: delaySeconds,

  extracted: {
    lead_stage: finalStage,
    media_intent: mediaIntent,
    delay_seconds: delaySeconds,
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
    reply_text: 'Hubo un problema procesando tu mensaje 🙏 escríbeme otra vez en un solo mensaje.',
    status: 'continue',
    lead_stage: normalizeStage(body.lead_stage),
    media_intent: 'none',
    delay_seconds: 3,
    extracted: {
      lead_stage: normalizeStage(body.lead_stage),
      media_intent: 'none',
      delay_seconds: 3
    }
  });
}
});

app.listen(config.port, () => {
  console.log('Server running...');
});
