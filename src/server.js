import express from 'express';
import OpenAI from 'openai';
import { config } from './config.js';
import { buildSystemPrompt } from './prompt.js';
import { responseJsonSchema } from './schemas.js';
import { buildConversationInput, inboundSchema } from './leadRouter.js';

function normalizeSpanish(text) {
  return text
    // accents
    .replace(/manana/gi, 'mañana')
    .replace(/tarde(cita)?/gi, 'tarde')
    .replace(/temprano/gi, 'en la mañana')
    .replace(/tardecita/gi, 'en la tarde')
    .replace(/nochecita/gi, 'en la noche')
    .replace(/si\b/gi, 'sí')

    // normalize informal phrases
    .replace(/tipo\s*(\d+)/gi, '$1')
    .replace(/como a las?\s*(\d+)/gi, '$1')
    .replace(/eso de las?\s*(\d+)/gi, '$1');
}
function interpretTime(text) {
  const msg = text.toLowerCase();

  if (msg.includes('mañana') || msg.includes('temprano')) {
    return 'en la mañana (9:00 AM aprox.)';
  }

  if (msg.includes('tarde')) {
    return 'en la tarde (3:00 PM aprox.)';
  }

  if (msg.includes('noche')) {
    return 'en la noche (6:30 PM aprox.)';
  }

  // exact hour
  const hourMatch = msg.match(/\b(\d{1,2})(:\d{2})?\b/);
  if (hourMatch) {
    return hourMatch[0];
  }

  return text;
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

    // 1. HANDOFF LOCK
    if (String(payload.lead_stage || '').toLowerCase() === 'handoff_human') {
      const msg = userMsg;

      const hasPhoneNumber = /\b(809|829|849)[-\s]?\d{3}[-\s]?\d{4}\b/.test(msg);

      if (hasPhoneNumber) {
        return res.json({
          ok: true,
          reply_text: 'Perfecto 🔥 Ya tengo tu WhatsApp.\n\nTe escribo por ahí con la ubicación y los detalles de la visita.',
          status: 'handoff',
          next_step_label: 'handoff_human',
          extracted: {},
          internal_note: 'WhatsApp number captured',
          owner_phone: config.escalationPhone
        });
      }

      if (
        msg.includes('ya te lo di') ||
        msg.includes('ya te lo mande') ||
        msg.includes('ya te lo envié')
      ) {
        return res.json({
          ok: true,
          reply_text: 'Perfecto 🔥 Ya lo tengo.\n\nTe escribo ahora con la ubicación y los detalles.',
          status: 'handoff',
          next_step_label: 'handoff_human',
          extracted: {},
          internal_note: 'User confirmed phone previously',
          owner_phone: config.escalationPhone
        });
      }

      if (msg.includes('gracias')) {
        return res.json({
          ok: true,
          reply_text: 'A la orden 👍',
          status: 'handoff',
          next_step_label: 'handoff_human',
          extracted: {},
          internal_note: 'Thanks handled after handoff',
          owner_phone: config.escalationPhone
        });
      }

      if (msg.includes('whatsapp') && msg.includes('mejor')) {
        return res.json({
          ok: true,
          reply_text: 'Perfecto 👍 entonces seguimos por WhatsApp.',
          status: 'handoff',
          next_step_label: 'handoff_human',
          extracted: {},
          internal_note: 'WhatsApp preference handled',
          owner_phone: config.escalationPhone
        });
      }

      if (msg.includes('whatsapp') && (msg.includes('no') || msg.includes('no tengo'))) {
        return res.json({
          ok: true,
          reply_text: 'No hay problema 👍 Podemos seguir por aquí mismo.\n\nTe paso la ubicación y coordinamos todo por este DM.',
          status: 'handoff',
          next_step_label: 'handoff_human',
          extracted: {},
          internal_note: 'No WhatsApp handled',
          owner_phone: config.escalationPhone
        });
      }
     if (
      msg === 'si' ||
      msg === 'sí' ||
      msg === 'esta bien' ||
      msg === 'está bien' ||
      msg.includes('para ver dónde') ||
      msg.includes('para ver donde') ||
      msg.includes('ubicación') ||
      msg.includes('ubicacion')
) {
  return res.json({
    ok: true,
    reply_text: 'Perfecto 👍 La casa está ubicada en Residencial Doña María, Santo Domingo Norte.\n\nAquí tienes la ubicación exacta:\nhttps://maps.app.goo.gl/NAB4CLb9d4xDSgvH7\n\nCuando llegues, me escribes por aquí o por WhatsApp para coordinar la visita.',
    status: 'handoff',
    next_step_label: 'handoff_human',
    extracted: {},
    internal_note: 'Exact location sent',
    owner_phone: config.escalationPhone
  });
    if (
      msg === 'bien' ||
      msg.includes('mandala') ||
      msg.includes('mándala') ||
      msg.includes('pasamela') ||
      msg.includes('pásamela') ||
      msg.includes('enviamela') ||
      msg.includes('envíamela') ||
      msg.includes('ubicación') ||
      msg.includes('ubicacion')
) {
  return res.json({
    ok: true,
    reply_text: 'Perfecto 👍 La casa está ubicada en Residencial Doña María, Santo Domingo Norte.\n\nAquí tienes la ubicación exacta:\nhttps://maps.app.goo.gl/NAB4CLb9d4xDSgvH7',
    status: 'handoff',
    next_step_label: 'handoff_human',
    extracted: {},
    internal_note: 'Exact location sent',
    owner_phone: config.escalationPhone
  });
}
}
   const normalizedHandoffMsg = msg
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[¿?¡!.,]/g, "");

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
    reply_text: 'Perfecto 👍 La casa está ubicada en Residencial Doña María, Santo Domingo Norte.\n\nAquí tienes la ubicación exacta:\nhttps://maps.app.goo.gl/NAB4CLb9d4xDSgvH7\n\nCuando llegues, me escribes por aquí o por WhatsApp para coordinar la visita.',
    status: 'handoff',
    next_step_label: 'handoff_human',
    extracted: {},
    internal_note: 'Exact location sent after handoff',
    owner_phone: config.escalationPhone
  });
}   
      if (
  msg.includes('rebaja') ||
  msg.includes('descuento') ||
  msg.includes('negociable') ||
  msg.includes('mejor precio')
) {
  return res.json({
    ok: true,
    reply_text: 'Entiendo 👍 El precio está bastante ajustado, pero si vienes a verla y tienes una propuesta seria, se puede conversar.\n\n¿Quieres que coordinemos la visita?',
    status: 'handoff',
    next_step_label: 'handoff_human',
    extracted: {},
    internal_note: 'Discount question handled after handoff',
    owner_phone: config.escalationPhone
  });
}
     if (msg.trim() === '?') {
  return res.json({
    ok: true,
    reply_text: 'Entiendo 👍 Sobre la rebaja, el precio está bastante ajustado, pero si vienes a verla y tienes una propuesta seria, se puede conversar.\n\n¿Quieres que coordinemos la visita?',
    status: 'handoff',
    next_step_label: 'handoff_human',
    extracted: {},
    internal_note: 'Split discount question handled',
    owner_phone: config.escalationPhone
  });
} 
      return res.json({
        ok: true,
        reply_text: 'Perfecto 👍\n\nTe paso la ubicación por aquí y coordinamos la visita por este DM.',
        status: 'handoff',
        next_step_label: 'handoff_human',
        extracted: {},
        internal_note: 'Handoff handled',
        owner_phone: config.escalationPhone
      });
    }
  
    // 2. PRICE / NEGOTIATION HANDLERS
    const isMinimumAsk =
      userMsg.includes('lo minimo') ||
      userMsg.includes('mínimo') ||
      userMsg.includes('minimo') ||
      userMsg.includes('lo menos') ||
      userMsg.includes('precio final');

    if (isMinimumAsk) {
      return res.json({
        ok: true,
        reply_text: 'Entiendo 👍 El precio está bastante ajustado por el potencial que tiene la propiedad.\n\nLo ideal es que la veas primero y así evalúas si realmente te conviene. ¿Te gustaría visitarla?',
        status: 'continue',
        next_step_label: 'visit_interest',
        extracted: {},
        internal_note: 'Minimum price negotiation handled',
        owner_phone: config.escalationPhone
      });
    }

    const priceNumber = parseFloat(userMsg.replace(/[^0-9.]/g, ''));

    const mentionsPrice =
      userMsg.includes('millones') ||
      userMsg.includes('millon') ||
      userMsg.includes('millón') ||
      userMsg.includes('la dejan') ||
      userMsg.includes('lo dejan') ||
      userMsg.includes('cogen') ||
      userMsg.includes('aceptan') ||
      /\ben\s*\d/.test(userMsg) ||
      userMsg.includes('te doy') ||
      userMsg.includes('ofrezco');

    const isNearOffer =
      mentionsPrice &&
      priceNumber &&
      priceNumber >= 4.0 &&
      priceNumber < 4.5;

    if (isNearOffer) {
      return res.json({
        ok: true,
        reply_text: 'Estás bastante cerca 👍\n\nLo ideal es que la veas en persona primero y, si realmente te interesa, se puede conversar con una propuesta seria. ¿Te gustaría coordinar una visita?',
        status: 'continue',
        next_step_label: 'visit_interest',
        extracted: {},
        internal_note: 'Near offer handled',
        owner_phone: config.escalationPhone
      });
    }

    const isLowball =
      mentionsPrice &&
      priceNumber &&
      priceNumber < 4.0;

    if (isLowball) {
      return res.json({
        ok: true,
        reply_text: 'Entiendo 👍 Pero por ese rango se queda fuera del valor actual de la propiedad.\n\nSi quieres verla, puedes evaluar mejor el potencial real. ¿Te gustaría visitarla?',
        status: 'continue',
        next_step_label: 'visit_interest',
        extracted: {},
        internal_note: 'Lowball handled',
        owner_phone: config.escalationPhone
      });
    }

    // 3. VISIT TIME / ACCEPTANCE
    const hasVisitTime =
      userMsg.includes('hoy') ||
      userMsg.includes('mañana') ||
      userMsg.includes('lunes') ||
      userMsg.includes('martes') ||
      userMsg.includes('miércoles') ||
      userMsg.includes('miercoles') ||
      userMsg.includes('jueves') ||
      userMsg.includes('viernes') ||
      userMsg.includes('sábado') ||
      userMsg.includes('sabado') ||
      userMsg.includes('domingo') ||
      userMsg.includes('en la mañana') ||
      userMsg.includes('en la tarde') ||
      userMsg.includes('en la noche') ||
      /\b(a las|a eso de|como a las)\s*\d{1,2}(:\d{2})?\s?(am|pm)?\b/.test(userMsg);

    if (hasVisitTime) {
    const cleanMsg = normalizeSpanish(payload.last_user_message);
     const finalTime = interpretTime(cleanMsg);

      return res.json({
        ok: true,
        reply_text: `Perfecto 🔥 Queda anotado para ${finalTime}.\n\nTe escribo con la ubicación y los detalles de la visita.`,
        status: 'handoff',
        next_step_label: 'handoff_human',
        extracted: {},
        internal_note: 'Visit time captured directly',
        owner_phone: config.escalationPhone
  });
}

    const alreadyAnswered =
      userMsg.includes('ya te respondi') ||
      userMsg.includes('ya te respondí') ||
      userMsg.includes('ya te dije');

    if (alreadyAnswered) {
      return res.json({
        ok: true,
        reply_text: 'Tienes razón 👍 Ya tengo tu respuesta.\n\nTe escribo con la ubicación y los detalles de la visita.',
        status: 'handoff',
        next_step_label: 'handoff_human',
        extracted: {},
        internal_note: 'User said they already answered',
        owner_phone: config.escalationPhone
      });
    }

    const isVisitAcceptance =
      userMsg === 'si' ||
      userMsg === 'sí' ||
      userMsg === 'dale' ||
      userMsg === 'perfecto' ||
      userMsg === 'esta bien' ||
      userMsg === 'está bien';

    if (isVisitAcceptance) {
      return res.json({
        ok: true,
        reply_text: '¡Perfecto! 👍 ¿Qué día y hora te viene mejor para visitar la propiedad?',
        status: 'continue',
        next_step_label: 'schedule_visit',
        extracted: {},
        internal_note: 'Visit acceptance detected',
        owner_phone: config.escalationPhone
      });
    }

    // 4. SOFT CLOSE
    const wantsLater =
      userMsg.includes('despues') ||
      userMsg.includes('después') ||
      userMsg.includes('mas tarde') ||
      userMsg.includes('más tarde') ||
      userMsg.includes('luego') ||
      userMsg.includes('ahorita no') ||
      userMsg.includes('no ahora') ||
      userMsg.includes('quizas') ||
      userMsg.includes('quizás');

    const hesitationStage =
      String(payload.lead_stage || '').toLowerCase() !== 'schedule_visit';

    if (wantsLater && hesitationStage) {
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

    const normalizedMsg = userMsg
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[¿?¡!.,]/g, ""); // remove punctuation
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
    reply_text: 'Perfecto 👍 La casa está ubicada en Residencial Doña María, Santo Domingo Norte.\n\nAquí tienes la ubicación exacta:\nhttps://maps.app.goo.gl/NAB4CLb9d4xDSgvH7\n\nCuando llegues, me escribes por aquí o por WhatsApp para coordinar la visita.',
    status: 'continue',
    next_step_label: 'visit_interest',
    extracted: {},
    internal_note: 'Location requested and sent',
    owner_phone: config.escalationPhone
  });
}
    // 5. AI RESPONSE
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
      userMsg.includes('vivir') ||
      userMsg.includes('vivienda') ||
      userMsg.includes('invertir') ||
      userMsg.includes('inversion') ||
      userMsg.includes('inversión');

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
