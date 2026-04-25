import express from 'express';
import OpenAI from 'openai';
import { config } from './config.js';
import { buildSystemPrompt } from './prompt.js';
import { responseJsonSchema } from './schemas.js';
import { buildConversationInput, inboundSchema } from './leadRouter.js';

function normalizeSpanish(text) {
  return String(text || '')
    .replace(/manana/gi, 'mañana')
    .replace(/miercoles/gi, 'miércoles')
    .replace(/sabado/gi, 'sábado')
    .replace(/tardecita/gi, 'en la tarde')
    .replace(/nochecita/gi, 'en la noche')
    .replace(/temprano/gi, 'en la mañana')
    .replace(/si\b/gi, 'sí');
}

function normalizeForMatching(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,]/g, '');
}

function interpretTime(text) {
  const msg = String(text || '').toLowerCase();

  if (msg.includes('mañana') || msg.includes('temprano')) {
    return 'en la mañana (9:00 AM aprox.)';
  }

  if (msg.includes('tarde')) {
    return 'en la tarde (3:00 PM aprox.)';
  }

  if (msg.includes('noche')) {
    return 'en la noche (6:30 PM aprox.)';
  }

  return text;
}

function memory(last_intent = '', last_question_context = '', last_bot_reply = '') {
  return {
    last_intent,
    last_question_context,
    last_bot_reply
  };
}

const app = express();
const openai = new OpenAI({ apiKey: config.openAiApiKey });

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'lead-automation-backend' });
});

function detectNextStage(payload, aiNextStep) {
  const msg = String(payload.last_user_message || '').toLowerCase();
  const stage = String(payload.lead_stage || '').toLowerCase();

  const hasIntent =
    msg.includes('vivir') ||
    msg.includes('vivienda') ||
    msg.includes('invertir') ||
    msg.includes('inversion') ||
    msg.includes('inversión');

  const wantsVisit =
    msg.includes('ver') ||
    msg.includes('visita') ||
    msg.includes('interesa') ||
    msg.includes('quiero') ||
    msg.includes('sí') ||
    msg.includes('si');

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
    msg.includes('en la mañana') ||
    msg.includes('en la tarde') ||
    msg.includes('en la noche') ||
    /\b(a las|a eso de|como a las)\s*\d{1,2}(:\d{2})?\s?(am|pm)?\b/.test(msg);

  if (payload.lead_type !== 'buyer') return aiNextStep;

  if (givesTime) return 'handoff_human';
  if (wantsVisit && stage === 'visit_interest') return 'schedule_visit';
  if (hasIntent) return 'visit_interest';

  return aiNextStep || stage || 'ask_intent';
}

app.post('/webhooks/manychat', async (req, res) => {
  try {
    const payload = inboundSchema.parse(req.body);

    if (payload.secret !== config.webhookSecret) {
      return res.status(401).json({ ok: false, error: 'Invalid secret.' });
    }

    const userMsg = String(payload.last_user_message || '').toLowerCase();
    const normalizedMsg = normalizeForMatching(userMsg);
    const lastIntent = String(payload.last_intent || '').toLowerCase();

    const locationReply =
      'Perfecto 👍 La casa está ubicada en Residencial Doña María, Santo Domingo Norte.\n\n' +
      'Aquí tienes la ubicación exacta:\n' +
      'https://maps.app.goo.gl/NAB4CLb9d4xDSgvH7\n\n' +
      'Cuando llegues, me escribes por aquí o por WhatsApp para coordinar la visita.';

    // 0. SPLIT MESSAGE MEMORY HANDLER
    if (userMsg.trim() === '?' && lastIntent === 'discount') {
      const reply =
        'Entiendo 👍 Sobre la rebaja, el precio está bastante ajustado.\n\n' +
        'Si vienes a verla y te interesa, se puede conversar una propuesta seria.';

      return res.json({
        ok: true,
        reply_text: reply,
        status: 'continue',
        next_step_label: 'visit_interest',
        extracted: {},
        internal_note: 'Split discount handled from memory',
        owner_phone: config.escalationPhone,
        memory_updates: memory('discount', 'rebaja', reply)
      });
    }

    const asksForDiscount =
      normalizedMsg.includes('rebaja') ||
      normalizedMsg.includes('descuento') ||
      normalizedMsg.includes('negociable') ||
      normalizedMsg.includes('mejor precio');

    if (asksForDiscount) {
      const reply =
        'Entiendo 👍 El precio está bastante ajustado por el potencial que tiene la propiedad.\n\n' +
        'Si te interesa, lo ideal es verla primero y luego podemos conversar.';

      return res.json({
        ok: true,
        reply_text: reply,
        status: 'continue',
        next_step_label: 'visit_interest',
        extracted: {},
        internal_note: 'Discount question handled',
        owner_phone: config.escalationPhone,
        memory_updates: memory('discount', 'rebaja', reply)
      });
    }

    // 1. HANDOFF LOCK
    if (String(payload.lead_stage || '').toLowerCase() === 'handoff_human') {
      const msg = userMsg;
      const normalizedHandoffMsg = normalizeForMatching(msg);

      const hasPhoneNumber = /\b(809|829|849)[-\s]?\d{3}[-\s]?\d{4}\b/.test(msg);

      if (hasPhoneNumber) {
        const reply =
          'Perfecto 🔥 Ya tengo tu WhatsApp.\n\n' +
          'Te escribo por ahí con la ubicación y los detalles de la visita.';

        return res.json({
          ok: true,
          reply_text: reply,
          status: 'handoff',
          next_step_label: 'handoff_human',
          extracted: {},
          internal_note: 'WhatsApp number captured',
          owner_phone: config.escalationPhone,
          memory_updates: memory('phone_captured', 'whatsapp', reply)
        });
      }

      if (
        normalizedHandoffMsg.includes('ya te lo di') ||
        normalizedHandoffMsg.includes('ya te lo mande') ||
        normalizedHandoffMsg.includes('ya te lo envie')
      ) {
        const reply =
          'Perfecto 🔥 Ya lo tengo.\n\n' +
          'Te escribo ahora con la ubicación y los detalles.';

        return res.json({
          ok: true,
          reply_text: reply,
          status: 'handoff',
          next_step_label: 'handoff_human',
          extracted: {},
          internal_note: 'User confirmed phone previously',
          owner_phone: config.escalationPhone,
          memory_updates: memory('phone_confirmed', 'whatsapp', reply)
        });
      }

      if (normalizedHandoffMsg.includes('gracias')) {
        const reply = 'A la orden 👍';

        return res.json({
          ok: true,
          reply_text: reply,
          status: 'handoff',
          next_step_label: 'handoff_human',
          extracted: {},
          internal_note: 'Thanks handled after handoff',
          owner_phone: config.escalationPhone,
          memory_updates: memory('thanks', 'soft_close', reply)
        });
      }

      if (normalizedHandoffMsg.includes('whatsapp') && normalizedHandoffMsg.includes('mejor')) {
        const reply = 'Perfecto 👍 entonces seguimos por WhatsApp.';

        return res.json({
          ok: true,
          reply_text: reply,
          status: 'handoff',
          next_step_label: 'handoff_human',
          extracted: {},
          internal_note: 'WhatsApp preference handled',
          owner_phone: config.escalationPhone,
          memory_updates: memory('whatsapp_preference', 'handoff', reply)
        });
      }

      if (
        normalizedHandoffMsg.includes('whatsapp') &&
        (normalizedHandoffMsg.includes('no') || normalizedHandoffMsg.includes('no tengo'))
      ) {
        const reply =
          'No hay problema 👍 Podemos seguir por aquí mismo.\n\n' +
          'Te paso la ubicación y coordinamos todo por este DM.';

        return res.json({
          ok: true,
          reply_text: reply,
          status: 'handoff',
          next_step_label: 'handoff_human',
          extracted: {},
          internal_note: 'No WhatsApp handled',
          owner_phone: config.escalationPhone,
          memory_updates: memory('no_whatsapp', 'handoff', reply)
        });
      }

      const asksForLocationAfterHandoff =
        normalizedHandoffMsg.includes('ubicacion') ||
        normalizedHandoffMsg.includes('mandame') ||
        normalizedHandoffMsg.includes('mandamela') ||
        normalizedHandoffMsg.includes('mandala') ||
        normalizedHandoffMsg.includes('pasamela') ||
        normalizedHandoffMsg.includes('enviamela') ||
        normalizedHandoffMsg.includes('donde esta') ||
        normalizedHandoffMsg.includes('donde queda') ||
        normalizedHandoffMsg.includes('direccion');

      if (asksForLocationAfterHandoff) {
        return res.json({
          ok: true,
          reply_text: locationReply,
          status: 'handoff',
          next_step_label: 'handoff_human',
          extracted: {},
          internal_note: 'Exact location sent after handoff',
          owner_phone: config.escalationPhone,
          memory_updates: memory('location_sent', 'location', locationReply)
        });
      }

      if (normalizedHandoffMsg.includes('titulo')) {
        const reply = 'Sí 👍 La propiedad tiene título al día.';

        return res.json({
          ok: true,
          reply_text: reply,
          status: 'handoff',
          next_step_label: 'handoff_human',
          extracted: {},
          internal_note: 'Title answered after handoff',
          owner_phone: config.escalationPhone,
          memory_updates: memory('title_answered', 'title', reply)
        });
      }

      if (
        normalizedHandoffMsg.includes('rebaja') ||
        normalizedHandoffMsg.includes('descuento') ||
        normalizedHandoffMsg.includes('negociable') ||
        normalizedHandoffMsg.includes('mejor precio')
      ) {
        const reply =
          'Entiendo 👍 El precio está bastante ajustado, pero si vienes a verla y tienes una propuesta seria, se puede conversar.\n\n' +
          '¿Quieres que coordinemos la visita?';

        return res.json({
          ok: true,
          reply_text: reply,
          status: 'handoff',
          next_step_label: 'handoff_human',
          extracted: {},
          internal_note: 'Discount question handled after handoff',
          owner_phone: config.escalationPhone,
          memory_updates: memory('discount', 'rebaja', reply)
        });
      }

      if (msg.trim() === '?' && lastIntent === 'discount') {
        const reply =
          'Entiendo 👍 Sobre la rebaja, el precio está bastante ajustado.\n\n' +
          'Si vienes a verla y tienes una propuesta seria, se puede conversar.';

        return res.json({
          ok: true,
          reply_text: reply,
          status: 'handoff',
          next_step_label: 'handoff_human',
          extracted: {},
          internal_note: 'Split discount question handled after handoff',
          owner_phone: config.escalationPhone,
          memory_updates: memory('discount', 'rebaja', reply)
        });
      }

      const reply =
        'Perfecto 👍\n\n' +
        'Te paso la ubicación por aquí y coordinamos la visita por este DM.';

      return res.json({
        ok: true,
        reply_text: reply,
        status: 'handoff',
        next_step_label: 'handoff_human',
        extracted: {},
        internal_note: 'Handoff handled',
        owner_phone: config.escalationPhone,
        memory_updates: memory('handoff', 'default', reply)
      });
    }

    // 2. PRICE / NEGOTIATION HANDLERS
    const isMinimumAsk =
      normalizedMsg.includes('lo minimo') ||
      normalizedMsg.includes('minimo') ||
      normalizedMsg.includes('lo menos') ||
      normalizedMsg.includes('precio final');

    if (isMinimumAsk) {
      const reply =
        'Entiendo 👍 El precio está bastante ajustado por el potencial que tiene la propiedad.\n\n' +
        'Lo ideal es que la veas primero y así evalúas si realmente te conviene. ¿Te gustaría visitarla?';

      return res.json({
        ok: true,
        reply_text: reply,
        status: 'continue',
        next_step_label: 'visit_interest',
        extracted: {},
        internal_note: 'Minimum price negotiation handled',
        owner_phone: config.escalationPhone,
        memory_updates: memory('minimum_price', 'price', reply)
      });
    }

    const priceNumber = parseFloat(userMsg.replace(/[^0-9.]/g, ''));

    const mentionsPrice =
      normalizedMsg.includes('millones') ||
      normalizedMsg.includes('millon') ||
      normalizedMsg.includes('la dejan') ||
      normalizedMsg.includes('lo dejan') ||
      normalizedMsg.includes('cogen') ||
      normalizedMsg.includes('aceptan') ||
      /\ben\s*\d/.test(normalizedMsg) ||
      normalizedMsg.includes('te doy') ||
      normalizedMsg.includes('ofrezco');

    const isNearOffer =
      mentionsPrice &&
      priceNumber &&
      priceNumber >= 4.0 &&
      priceNumber < 4.5;

    if (isNearOffer) {
      const reply =
        'Estás bastante cerca 👍\n\n' +
        'Lo ideal es que la veas en persona primero y, si realmente te interesa, se puede conversar con una propuesta seria. ¿Te gustaría coordinar una visita?';

      return res.json({
        ok: true,
        reply_text: reply,
        status: 'continue',
        next_step_label: 'visit_interest',
        extracted: {},
        internal_note: 'Near offer handled',
        owner_phone: config.escalationPhone,
        memory_updates: memory('near_offer', 'price', reply)
      });
    }

    const isLowball =
      mentionsPrice &&
      priceNumber &&
      priceNumber < 4.0;

    if (isLowball) {
      const reply =
        'Entiendo 👍 Pero por ese rango se queda fuera del valor actual de la propiedad.\n\n' +
        'Si quieres verla, puedes evaluar mejor el potencial real. ¿Te gustaría visitarla?';

      return res.json({
        ok: true,
        reply_text: reply,
        status: 'continue',
        next_step_label: 'visit_interest',
        extracted: {},
        internal_note: 'Lowball handled',
        owner_phone: config.escalationPhone,
        memory_updates: memory('lowball', 'price', reply)
      });
    }

    // 3. LOCATION REQUEST
    const asksForLocation =
      normalizedMsg.includes('ubicacion') ||
      normalizedMsg.includes('mandame la ubicacion') ||
      normalizedMsg.includes('mandamela') ||
      normalizedMsg.includes('mandala') ||
      normalizedMsg.includes('pasamela') ||
      normalizedMsg.includes('enviamela') ||
      normalizedMsg.includes('donde esta') ||
      normalizedMsg.includes('donde queda') ||
      normalizedMsg.includes('direccion');

    if (asksForLocation) {
      return res.json({
        ok: true,
        reply_text: locationReply,
        status: 'continue',
        next_step_label: 'visit_interest',
        extracted: {},
        internal_note: 'Location requested and sent',
        owner_phone: config.escalationPhone,
        memory_updates: memory('location_sent', 'location', locationReply)
      });
    }

    // 4. VISIT TIME / ACCEPTANCE
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
      const cleanMsg = normalizeSpanish(payload.last_user_message);
      const finalTime = interpretTime(cleanMsg);
      const reply =
        `Perfecto 🔥 Queda anotado para ${finalTime}.\n\n` +
        'Te escribo con la ubicación y los detalles de la visita.';

      return res.json({
        ok: true,
        reply_text: reply,
        status: 'handoff',
        next_step_label: 'handoff_human',
        extracted: {},
        internal_note: 'Visit time captured directly',
        owner_phone: config.escalationPhone,
        memory_updates: memory('visit_scheduled', 'visit_time', reply)
      });
    }

    const alreadyAnswered =
      normalizedMsg.includes('ya te respondi') ||
      normalizedMsg.includes('ya te dije');

    if (alreadyAnswered) {
      const reply =
        'Tienes razón 👍 Ya tengo tu respuesta.\n\n' +
        'Te escribo con la ubicación y los detalles de la visita.';

      return res.json({
        ok: true,
        reply_text: reply,
        status: 'handoff',
        next_step_label: 'handoff_human',
        extracted: {},
        internal_note: 'User said they already answered',
        owner_phone: config.escalationPhone,
        memory_updates: memory('already_answered', 'visit', reply)
      });
    }

    const isVisitAcceptance =
      normalizedMsg === 'si' ||
      normalizedMsg === 'dale' ||
      normalizedMsg === 'perfecto' ||
      normalizedMsg === 'esta bien' ||
      normalizedMsg === 'bien';

    if (isVisitAcceptance) {
      const reply =
        '¡Perfecto! 👍 ¿Qué día y hora te viene mejor para visitar la propiedad?';

      return res.json({
        ok: true,
        reply_text: reply,
        status: 'continue',
        next_step_label: 'schedule_visit',
        extracted: {},
        internal_note: 'Visit acceptance detected',
        owner_phone: config.escalationPhone,
        memory_updates: memory('visit_acceptance', 'visit', reply)
      });
    }

    // 5. SOFT CLOSE
    const wantsLater =
      normalizedMsg.includes('despues') ||
      normalizedMsg.includes('mas tarde') ||
      normalizedMsg.includes('luego') ||
      normalizedMsg.includes('ahorita no') ||
      normalizedMsg.includes('no ahora') ||
      normalizedMsg.includes('quizas');

    const hesitationStage =
      String(payload.lead_stage || '').toLowerCase() !== 'schedule_visit';

    if (wantsLater && hesitationStage) {
      const reply =
        'Perfecto 👍 Escríbeme cuando estés listo y coordinamos sin presión.';

      return res.json({
        ok: true,
        reply_text: reply,
        status: 'continue',
        next_step_label: 'nurture',
        extracted: {},
        internal_note: 'Soft close handled',
        owner_phone: config.escalationPhone,
        memory_updates: memory('soft_close', 'later', reply)
      });
    }

    // 6. AI RESPONSE
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

    let forcedReply = parsed.reply_text;
    let forcedNextStep = nextStep;

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

    if (badPatterns.some((p) => forcedReply.toLowerCase().includes(p))) {
      forcedReply = 'Perfecto 👌 ¿Te gustaría coordinar una visita para verla en persona?';
      forcedNextStep = 'visit_interest';
    }

    const alreadySaidIntent =
      normalizedMsg.includes('vivir') ||
      normalizedMsg.includes('vivienda') ||
      normalizedMsg.includes('invertir') ||
      normalizedMsg.includes('inversion');

    if (alreadySaidIntent && forcedReply.toLowerCase().includes('vivir')) {
      forcedReply = 'Perfecto 👌 ¿Te gustaría venir a verla en persona?';
      forcedNextStep = 'visit_interest';
    }

    const finalReply =
      parsed.status === 'handoff' || forcedNextStep === 'handoff_human'
        ? `Perfecto 🔥 Queda anotado para ${payload.last_user_message}.\n\nTe escribo con la ubicación y los detalles de la visita.`
        : forcedReply;

    return res.json({
      ok: true,
      reply_text: finalReply,
      status: forcedNextStep === 'handoff_human' ? 'handoff' : parsed.status,
      next_step_label: forcedNextStep,
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
