import express from 'express';
import OpenAI from 'openai';
import { config } from './config.js';
import { buildSystemPrompt } from './prompt.js';
import { responseJsonSchema } from './schemas.js';
import { buildConversationInput, buildHandoffMessage, inboundSchema } from './leadRouter.js';

const app = express();
const openai = new OpenAI({ apiKey: config.openAiApiKey });

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'lead-automation-backend' });
});

function detectNextStage(payload, aiNextStep) {
  const msg = String(payload.last_user_message || '').toLowerCase();
  const stage = String(payload.lead_stage || '').toLowerCase();

  const hasBudget =
    /\d/.test(msg) ||
    msg.includes('millon') ||
    msg.includes('millón') ||
    msg.includes('millones');

  const hasIntent =
    msg.includes('vivir') ||
    msg.includes('invertir') ||
    msg.includes('inversion') ||
    msg.includes('inversión');

  const wantsVisit =
    msg.includes('ver') ||
    msg.includes('visita') ||
    msg.includes('interesa') ||
    msg.includes('quiero') ||
    msg.includes('si') ||
    msg.includes('sí');

  const givesTime =
    msg.includes('hoy') ||
    msg.includes('mañana') ||
    msg.includes('lunes') ||
    msg.includes('martes') ||
    msg.includes('miércoles') ||
    msg.includes('miercoles') ||
    msg.includes('jueves') ||
    msg.includes('viernes') ||
    msg.includes('sábado') ||
    msg.includes('sabado') ||
    msg.includes('domingo') ||
    /\d{1,2}(:\d{2})?\s?(am|pm)?/.test(msg);

  if (payload.lead_type !== 'buyer') return aiNextStep;

  if (givesTime && stage === 'schedule_visit') return 'handoff_human';
  if (wantsVisit && stage === 'visit_interest') return 'schedule_visit';
  if (hasIntent) return 'visit_interest';
  if (hasBudget) return 'ask_intent';

  return aiNextStep || stage || 'ask_budget';
}

app.post('/webhooks/manychat', async (req, res) => {
  try {
    const payload = inboundSchema.parse(req.body);

if (String(payload.lead_stage || '').toLowerCase() === 'handoff_human') {

  const msg = String(payload.last_user_message || '').toLowerCase();

  let reply = 'Perfecto 👍 Seguimos por aquí mismo.\n\nTe paso la ubicación y coordinamos la visita por este DM.';

  if (msg.includes('whatsapp') && (msg.includes('no') || msg.includes('no tengo'))) {
    reply = 'No hay problema 👍 Podemos seguir por aquí mismo en Instagram.\n\nTe paso la ubicación y coordinamos todo por este DM.';
  }
if (
  msg.includes('whatsapp') &&
  (msg.includes('tienes') || msg.includes('tiene') || msg.includes('mi'))
) {
  reply = 'No, pero si quieres dármelo está bien 👍\n\nO te paso la ubicación por aquí mismo y coordinamos la visita por este DM.';
}
  if (msg.includes('dónde') || msg.includes('ubicacion') || msg.includes('ubicación')) {
    reply = 'Claro 👍 Ahora te paso la ubicación exacta por aquí mismo y coordinamos la visita.';
  }
if (
  msg.includes('no') &&
  (msg.includes('ahora') || msg.includes('más adelante') || msg.includes('mas adelante'))
) {
  forcedReply = 'Perfecto 👍 Cuando estés listo me escribes y coordinamos.\n\nSi quieres, puedo enviarte más fotos o detalles mientras tanto.';
  forcedNextStep = 'nurture';
}
  return res.json({
    ok: true,
    reply_text: reply,
    status: 'handoff',
    next_step_label: 'handoff_human',
    extracted: {},
    internal_note: 'Handoff follow-up handled',
    owner_phone: config.escalationPhone
  });
}
  const userMsg = String(payload.last_user_message || '').toLowerCase();

const softCloseOnly =
  userMsg.includes('está bien') ||
  userMsg.includes('esta bien') ||
  userMsg.includes('ok') ||
  userMsg.includes('gracias');

const hesitationStage =
  String(payload.lead_stage || '').toLowerCase() !== 'schedule_visit';

if (softCloseOnly && hesitationStage) {
  const lastBotReply = String(payload.last_bot_reply || '').toLowerCase();

  if (lastBotReply.includes('aquí estoy si necesitas más información')) {
    return res.json({
      ok: true,
      reply_text: '', // 🚫 no reply = prevents duplicate
      status: 'silent',
      next_step_label: 'nurture',
      extracted: {},
      internal_note: 'Duplicate soft close prevented',
      owner_phone: config.escalationPhone
    });
  }

  return res.json({
    ok: true,
    reply_text: 'Perfecto 👍 Aquí estoy si necesitas más información o quieres retomarlo más adelante.',
    status: 'continue',
    next_step_label: 'nurture',
    extracted: {},
    internal_note: 'Soft close handled',
    owner_phone: config.escalationPhone
  });
} 
    const isLowball =
  userMsg.includes('millones') &&
  parseFloat(userMsg.replace(/[^0-9.]/g, '')) < 4.0;

if (isLowball) {
  return res.json({
    ok: true,
    reply_text: 'Entiendo 👍 Pero por ese rango se queda fuera del valor actual de la propiedad.\n\nSi quieres verla, puedes evaluar mejor el potencial real. ¿Te gustaría visitarla?',
    status: 'continue',
    next_step_label: 'visit_interest',
    extracted: {},
    internal_note: 'Lowball handled',
    owner_phone:  config.escalationPhone
  });
}
    const input = buildConversationInput(payload);
    const systemPrompt = buildSystemPrompt({
      leadType: payload.lead_type,
      lead_stage: payload.lead_stage
    });

    const aiResponse = await openai.responses.create({
      model: config.openAiModel,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: systemPrompt }]
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: input }]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: responseJsonSchema.name,
          schema: responseJsonSchema.schema,
          strict: true
        }
      }
    });

    const rawText = aiResponse.output_text?.trim();
if (!rawText) {
  throw new Error('No model output_text returned.');
}

// ✅ FIRST define parsed
const parsed = JSON.parse(rawText);

// (if you have detectNextStage, keep it here)
const nextStep = detectNextStage(payload, parsed.next_step_label);

// ✅ THEN use parsed
let forcedReply = parsed.reply_text;
let forcedNextStep = nextStep;

// your logic continues ↓
const latestMsg = String(payload.last_user_message || '').toLowerCase();

// Block bad AI questions
const badPatterns = [
  'cuántas propiedades',
  'cuantas propiedades',
  'qué zona',
  'que zona',
  'dónde buscas',
  'donde buscas',
  'otras propiedades',
  'más opciones',
  'mas opciones'
];

if (badPatterns.some(p => forcedReply.toLowerCase().includes(p))) {
  forcedReply = 'Perfecto 👌 ¿Te gustaría coordinar una visita para verla en persona?';
  forcedNextStep = 'visit_interest';
}

// Prevent repeating vivir/invertir after user already answered intent
const alreadySaidIntent =
  latestMsg.includes('vivir') ||
  latestMsg.includes('vivienda') ||
  latestMsg.includes('invertir') ||
  latestMsg.includes('inversion') ||
  latestMsg.includes('inversión');

if (alreadySaidIntent && forcedReply.toLowerCase().includes('vivir')) {
  forcedReply = 'Perfecto 👌 ¿Te gustaría venir a verla en persona?';
  forcedNextStep = 'visit_interest';
}

const finalReply =
  parsed.status === 'handoff' || forcedNextStep === 'handoff_human'
    ? buildHandoffMessage(payload.lead_type)
    : forcedReply;

    return res.json({
      ok: true,
      reply_text: finalReply,
      status: nextStep === 'handoff_human' ? 'handoff' : parsed.status,
      next_step_label: forcedNextStep,
      extracted: parsed.extracted,
      internal_note: parsed.internal_note,
      owner_phone: config.escalationPhone
    });
  } catch (error) {
    console.error('Webhook error:', error);

    return res.status(500).json({
      ok: false,
      reply_text: 'Gracias. Dame un momento y te respondo ahora mismo.',
      status: 'handoff',
      next_step_label: 'handoff_human',
      extracted: {
        budget: null,
        intent: null,
        area: null,
        listing_count: null,
        lead_source: null,
        urgency: null
      },
      internal_note: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.listen(config.port, () => {
  console.log(`Lead automation backend listening on port ${config.port}`);
});
