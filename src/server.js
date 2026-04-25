import express from 'express';
import OpenAI from 'openai';
import { config } from './config.js';
import { buildSystemPrompt } from './prompt.js';
import { responseJsonSchema } from './schemas.js';
import { buildConversationInput, inboundSchema } from './leadRouter.js';

const app = express();
const openai = new OpenAI({ apiKey: config.openAiApiKey });

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'lead-automation-backend' });
});

function normalizeForMatching(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,]/g, '')
    .trim();
}

function replyJson(res, {
  reply,
  status = 'continue',
  nextStep = 'info_requested',
  note = '',
  intent = '',
  context = ''
}) {
  return res.json({
    ok: true,
    reply_text: reply,
    status,
    next_step_label: nextStep,
    extracted: {},
    internal_note: note,
    owner_phone: config.escalationPhone,
    memory_updates: memory(intent, context, reply)
  });
}

function normalizeSpanish(text) {
  return String(text || '')
    .replace(/manana/gi, 'mañana')
    .replace(/miercoles/gi, 'miércoles')
    .replace(/sabado/gi, 'sábado')
    .replace(/tardecita/gi, 'en la tarde')
    .replace(/nochecita/gi, 'en la noche')
    .replace(/temprano/gi, 'en la mañana');
}

function interpretTime(text) {
  const msg = normalizeForMatching(text);

  if (msg.includes('manana') || msg.includes('temprano')) return 'en la mañana';
  if (msg.includes('tarde')) return 'en la tarde';
  if (msg.includes('noche')) return 'en la noche';

  return normalizeSpanish(text);
}

function memory(last_intent = '', last_question_context = '', last_bot_reply = '') {
  return { last_intent, last_question_context, last_bot_reply };
}

function detectNextStage(payload, aiNextStep) {
  const msg = normalizeForMatching(payload.last_user_message);
  const stage = String(payload.lead_stage || '').toLowerCase();

  if (payload.lead_type !== 'buyer') return aiNextStep;

  const hasIntent =
    msg.includes('vivir') ||
    msg.includes('vivienda') ||
    msg.includes('invertir') ||
    msg.includes('inversion');

  const wantsVisit =
    msg.includes('ver') ||
    msg.includes('visita') ||
    msg.includes('interesa') ||
    msg.includes('quiero');

  const givesTime =
    msg.includes('hoy') ||
    msg.includes('manana') ||
    msg.includes('lunes') ||
    msg.includes('martes') ||
    msg.includes('miercoles') ||
    msg.includes('jueves') ||
    msg.includes('viernes') ||
    msg.includes('sabado') ||
    msg.includes('domingo') ||
    msg.includes('en la manana') ||
    msg.includes('en la tarde') ||
    msg.includes('en la noche') ||
    /\b(a las|a eso de|como a las)\s*\d{1,2}(:\d{2})?\s?(am|pm)?\b/.test(msg);

  if (givesTime) return 'handoff_human';
  if (wantsVisit && stage === 'visit_interest') return 'schedule_visit';
  if (hasIntent) return 'visit_interest';

  return aiNextStep || stage || 'info_requested';
}

app.post('/webhooks/manychat', async (req, res) => {
  try {
    const payload = inboundSchema.parse(req.body);

    if (payload.secret !== config.webhookSecret) {
      return res.status(401).json({ ok: false, error: 'Invalid secret.' });
    }

    const rawMsg = String(payload.last_user_message || '');
const userMsg = rawMsg.toLowerCase();
const normalizedMsg = normalizeForMatching(rawMsg);
const rawTrim = rawMsg.trim().toLowerCase();

const isNoise =
  rawTrim === '?' ||
  rawTrim === '.' ||
  rawTrim === '¿' ||
  rawTrim === '!' ||
  rawTrim === '¡' ||
  rawTrim === '👍' ||
  rawTrim === 'ok' ||
  rawTrim === 'dale';

if (isNoise) {
  return res.json({
    ok: true,
    reply_text: '',
    status: 'silent',
    next_step_label: 'none',
    extracted: {},
    internal_note: 'Noise ignored',
    owner_phone: config.escalationPhone,
    memory_updates: memory(lastIntent, 'noise_ignored', '')
  });
}
    
    const currentStage = String(payload.lead_stage || '').toLowerCase();
    const lastIntent = String(payload.last_intent || '').toLowerCase();

    const locationReply =
      'Perfecto 👍 La casa está ubicada en Residencial Doña María, Santo Domingo Norte.\n\n' +
      'Aquí tienes la ubicación exacta:\n' +
      'https://maps.app.goo.gl/NAB4CLb9d4xDSgvH7\n\n' +
      'Cuando llegues, me escribes por aquí o por WhatsApp para coordinar la visita.';

    // 1. STOP / LATER / NOT NOW — highest priority
    const isHardSoftClose =
      normalizedMsg.includes('despues') ||
      normalizedMsg.includes('ahora no') ||
      normalizedMsg.includes('no ahora') ||
      normalizedMsg.includes('mas tarde') ||
      normalizedMsg.includes('luego') ||
      normalizedMsg.includes('cuando este listo') ||
      normalizedMsg.includes('te aviso') ||
      normalizedMsg.includes('no gracias');

    if (isHardSoftClose) {
      return replyJson(res, {
        reply: 'Perfecto 👍 Escríbeme cuando estés listo y coordinamos sin presión.',
        nextStep: 'nurture',
        note: 'Hard soft close handled',
        intent: 'soft_close',
        context: 'later'
      });
    }

    // 2. GREETING / RESET

const firstName = String(payload.first_name || '').trim();
const namePrefix = firstName ? `${firstName}, ` : '';

    const isGreetingOnly =
       normalizedMsg === 'hola' ||
       normalizedMsg === 'saludos' ||
       normalizedMsg === 'buenas' ||
       normalizedMsg === 'buen dia' ||
       normalizedMsg === 'buenas tardes' ||
       normalizedMsg === 'buenas noches';

       if (isGreetingOnly) {

  const greetings = [
    `¡Saludos! 👋 ${namePrefix}dime qué te gustaría saber de la casa.`,
    `Hola 👋 ${namePrefix}cuéntame, ¿qué te gustaría saber?`,
    `¡Hey! 👋 ${namePrefix}dime, ¿qué quieres saber de la propiedad?`
  ];

  const reply = greetings[Math.floor(Math.random() * greetings.length)];

  return replyJson(res, {
    reply,
    nextStep: 'info_requested',
    note: 'Greeting handled',
    intent: 'greeting',
    context: 'general'
  });
}

    // 3. USER WANTS TO ASK FIRST
    const wantsToAskFirst =
      normalizedMsg.includes('una pregunta') ||
      normalizedMsg.includes('preguntar') ||
      normalizedMsg.includes('saber algo') ||
      normalizedMsg.includes('algo primero') ||
      normalizedMsg.includes('primero');

    if (wantsToAskFirst) {
      return replyJson(res, {
        reply: 'Claro 👍 Pregúntame lo que quieras saber de la casa.',
        nextStep: 'info_requested',
        note: 'User wants to ask first',
        intent: 'question_pending',
        context: 'property_info'
      });
    }

    // 4. LOCATION REQUEST
    const asksForLocation =
      normalizedMsg.includes('ubicacion') ||
      normalizedMsg.includes('mandame') ||
      normalizedMsg.includes('mandamela') ||
      normalizedMsg.includes('mandala') ||
      normalizedMsg.includes('pasamela') ||
      normalizedMsg.includes('enviamela') ||
      normalizedMsg.includes('donde esta') ||
      normalizedMsg.includes('donde queda') ||
      normalizedMsg.includes('direccion');

    if (asksForLocation) {
      return replyJson(res, {
        reply: locationReply,
        status: currentStage === 'handoff_human' ? 'handoff' : 'continue',
        nextStep: currentStage === 'handoff_human' ? 'handoff_human' : 'visit_interest',
        note: 'Location requested and sent',
        intent: 'location_sent',
        context: 'location'
      });
    }

    // 5. PROPERTY QUESTIONS
    const asksTitle = normalizedMsg.includes('titulo');
    const asksWaterLight =
      normalizedMsg.includes('agua') ||
      normalizedMsg.includes('luz') ||
      normalizedMsg.includes('electricidad') ||
      normalizedMsg.includes('servicio');

    const asksFinancing =
      normalizedMsg.includes('financiamiento') ||
      normalizedMsg.includes('financian') ||
      normalizedMsg.includes('banco');

    if (asksTitle) {
      return replyJson(res, {
        reply: 'Sí 👍 La propiedad tiene título al día.',
        nextStep: 'info_provided',
        note: 'Title answered',
        intent: 'question',
        context: 'title'
      });
    }

    if (asksWaterLight) {
      return replyJson(res, {
        reply: 'Sí 👍 La propiedad cuenta con acceso a agua y luz disponibles.',
        nextStep: 'info_provided',
        note: 'Water/light answered',
        intent: 'question',
        context: 'utilities'
      });
    }

    if (asksFinancing) {
      return replyJson(res, {
        reply: 'El proyecto no incluye financiamiento directo. Para financiarla, habría que validarlo con un banco.',
        nextStep: 'info_provided',
        note: 'Financing answered',
        intent: 'question',
        context: 'financing'
      });
    }

    // 6. DISCOUNT / REBAJA
    const asksForDiscount =
      normalizedMsg.includes('rebaja') ||
      normalizedMsg.includes('descuento') ||
      normalizedMsg.includes('negociable') ||
      normalizedMsg.includes('mejor precio');

    if (asksForDiscount || (normalizedMsg === '' && lastIntent === 'discount') || (rawMsg.trim() === '?' && lastIntent === 'discount')) {
      return replyJson(res, {
        reply: 'Entiendo 👍 El precio está bastante ajustado por el potencial que tiene la propiedad.\n\nSi te interesa, lo ideal es verla primero y luego podemos conversar una propuesta seria.',
        nextStep: 'visit_interest',
        note: 'Discount handled',
        intent: 'discount',
        context: 'rebaja'
      });
    }

    // 7. PRICE INFO (SIMPLE QUESTION)
const asksPrice =
  normalizedMsg === 'precio' ||
  normalizedMsg === 'cuanto' ||
  normalizedMsg.includes('precio') ||
  normalizedMsg.includes('cuanto cuesta') ||
  normalizedMsg.includes('cuanto vale') ||
  normalizedMsg.includes('en cuanto');

if (asksPrice) {
  return replyJson(res, {
    reply: 'El precio de la casa es RD$4.5 millones.',
    nextStep: 'info_provided',
    note: 'Price info handled',
    intent: 'price_info',
    context: 'price'
  });
}
    
    // 8. PRICE / OFFER HANDLING
    const priceNumber = parseFloat(normalizedMsg.replace(/[^0-9.]/g, ''));

    const mentionsPrice =
      normalizedMsg.includes('millones') ||
      normalizedMsg.includes('millon') ||
      normalizedMsg.includes('me la dejan') ||
      normalizedMsg.includes('la dejan') ||
      normalizedMsg.includes('lo dejan') ||
      normalizedMsg.includes('cogen') ||
      normalizedMsg.includes('aceptan') ||
      normalizedMsg.includes('te doy') ||
      normalizedMsg.includes('ofrezco') ||
      /\ben\s*\d/.test(normalizedMsg);

    const isMinimumAsk =
      normalizedMsg.includes('lo minimo') ||
      normalizedMsg.includes('minimo') ||
      normalizedMsg.includes('lo menos') ||
      normalizedMsg.includes('precio final');

    if (isMinimumAsk) {
      return replyJson(res, {
        reply: 'Entiendo 👍 El precio está bastante ajustado por el potencial que tiene la propiedad.\n\nLo ideal es que la veas primero y así evalúas si realmente te conviene.',
        nextStep: 'visit_interest',
        note: 'Minimum price handled',
        intent: 'minimum_price',
        context: 'price'
      });
    }

    if (mentionsPrice && priceNumber && priceNumber < 4.0) {
      return replyJson(res, {
        reply: 'Entiendo 👍 Pero por ese rango se queda fuera del valor actual de la propiedad.\n\nSi quieres verla, puedes evaluar mejor el potencial real.',
        nextStep: 'visit_interest',
        note: 'Lowball handled',
        intent: 'lowball',
        context: 'price'
      });
    }

    if (mentionsPrice && priceNumber && priceNumber >= 4.0 && priceNumber < 4.5) {
      return replyJson(res, {
        reply: 'Estás bastante cerca 👍\n\nLo ideal es verla en persona primero y, si realmente te interesa, se puede conversar con una propuesta seria.',
        nextStep: 'visit_interest',
        note: 'Near offer handled',
        intent: 'near_offer',
        context: 'price'
      });
    }

    if (rawMsg.trim() === '?' && (lastIntent === 'near_offer' || lastIntent === 'lowball' || lastIntent === 'minimum_price')) {
      return replyJson(res, {
        reply: 'Sí 👍 La mejor forma es que la veas primero y luego, si te interesa, se conversa una propuesta seria.',
        nextStep: 'visit_interest',
        note: 'Price follow-up question handled',
        intent: 'price_followup',
        context: 'price'
      });
    }

    // 9. VISIT TIME
    const hasVisitTime =
      normalizedMsg.includes('hoy') ||
      normalizedMsg.includes('manana') ||
      normalizedMsg.includes('lunes') ||
      normalizedMsg.includes('martes') ||
      normalizedMsg.includes('miercoles') ||
      normalizedMsg.includes('jueves') ||
      normalizedMsg.includes('viernes') ||
      normalizedMsg.includes('sabado') ||
      normalizedMsg.includes('domingo') ||
      normalizedMsg.includes('en la manana') ||
      normalizedMsg.includes('en la tarde') ||
      normalizedMsg.includes('en la noche') ||
      /\b(a las|a eso de|como a las)\s*\d{1,2}(:\d{2})?\s?(am|pm)?\b/.test(normalizedMsg);

    if (hasVisitTime) {
      const finalTime = interpretTime(rawMsg);
      const reply =
        `Perfecto 🔥 Queda anotado para ${finalTime}.\n\n` +
        'Te escribo con la ubicación y los detalles de la visita.';

      return replyJson(res, {
        reply,
        status: 'handoff',
        nextStep: 'handoff_human',
        note: 'Visit time captured',
        intent: 'visit_scheduled',
        context: 'visit_time'
      });
    }

    // 10. VISIT ACCEPTANCE
    const isInNurtureMode =
      currentStage === 'nurture' ||
      lastIntent === 'soft_close';

    const isVisitAcceptance =
      !isInNurtureMode &&
      (
        normalizedMsg === 'si' ||
        normalizedMsg === 'dale' ||
        normalizedMsg === 'perfecto' ||
        normalizedMsg === 'esta bien' ||
        normalizedMsg === 'bien'
      );

    if (isVisitAcceptance) {
      return replyJson(res, {
        reply: '¡Perfecto! 👍 ¿Qué día y hora te viene mejor para visitar la propiedad?',
        nextStep: 'schedule_visit',
        note: 'Visit acceptance handled',
        intent: 'visit_acceptance',
        context: 'visit'
      });
    }

    // 11. HANDOFF MODE FALLBACK
    if (currentStage === 'handoff_human') {
      return replyJson(res, {
        reply: 'Perfecto 👍 Cualquier detalle, seguimos por aquí.',
        status: 'handoff',
        nextStep: 'handoff_human',
        note: 'Handoff fallback',
        intent: 'handoff',
        context: 'default'
      });
    }

    // 11. AI FALLBACK — only for messages not covered above
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

    const parsed = JSON.parse(rawText);
    const nextStep = detectNextStage(payload, parsed.next_step_label);

    let finalReply = parsed.reply_text;

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

    if (badPatterns.some((p) => finalReply.toLowerCase().includes(p))) {
      finalReply = 'Claro 👍 Dime qué te gustaría saber de esta casa.';
    }

    return res.json({
      ok: true,
      reply_text: finalReply,
      status: nextStep === 'handoff_human' ? 'handoff' : parsed.status,
      next_step_label: nextStep,
      extracted: parsed.extracted,
      internal_note: parsed.internal_note,
      owner_phone: config.escalationPhone,
      memory_updates: memory('ai_response', 'general', finalReply)
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
