import express from 'express';
import OpenAI from 'openai';
import { config } from './config.js';

const app = express();
const openai = new OpenAI({ apiKey: config.openAiApiKey });

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'lead-automation-backend' });
});

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function isNoiseMessage(rawText) {
  const raw = String(rawText || '').trim().toLowerCase();

  return (
    raw === '' ||
    raw === '?' ||
    raw === '.' ||
    raw === '¿' ||
    raw === '!' ||
    raw === '¡'
  );
}

function buildSystemPrompt() {
  return `
Eres un asistente de ventas inmobiliarias por DM de Instagram.

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
https://maps.app.goo.gl/NAB4CLb9d4xDSgvH7

ESTILO DE RESPUESTA:
- Responde corto, como DM real.
- No escribas párrafos largos.
- Usa tono cercano, dominicano, profesional y vendedor.
- No inventes información que no esté aquí.
- Si no sabes algo, responde con honestidad y ofrece coordinar con el encargado.
- No repitas la misma respuesta si el usuario cambia de tema.
- Si el usuario pregunta precio, responde el precio.
- Si pregunta ubicación, da la ubicación.
- Si pregunta título, responde que sí tiene título al día.
- Si pregunta agua o luz, responde que la propiedad cuenta con acceso a agua y luz.
- Si pregunta por rebaja, no aceptes una rebaja directa. Di que el precio está ajustado, pero que si la ve y tiene una propuesta seria se puede conversar.
- Si muestra interés en visitar, pregunta qué día y hora le conviene.
- Si da día/hora, confirma y di que se coordinarán los detalles.
- Si dice “después”, “ahora no”, “más adelante”, responde sin presionar.
- Si solo saluda, responde saludando y pregunta qué desea saber.
- Si el usuario manda un mensaje confuso, pide aclaración breve.

OBJETIVO:
Llevar al usuario naturalmente a visitar la propiedad, pero sin presionar demasiado.

FORMATO DE SALIDA:
Devuelve SOLO JSON válido con esta estructura exacta:

{
  "reply_text": "respuesta al usuario",
  "status": "continue",
  "next_step_label": "info_requested",
  "internal_note": "breve nota interna",
  "memory_updates": {
    "last_intent": "intent_detected",
    "last_question_context": "context_detected",
    "last_bot_reply": "same as reply_text"
  }
}
`;
}

app.post('/webhooks/manychat', async (req, res) => {
  try {
    const body = req.body || {};

    if (body.secret !== config.webhookSecret) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid secret.'
      });
    }

    const rawMsg = String(body.last_user_message || '');
    const normalizedMsg = normalizeText(rawMsg);
    const firstName = String(body.first_name || '').trim();
    const lastBotReply = String(body.last_bot_reply || '').trim();

    console.log('RAW MESSAGE:', rawMsg);
    console.log('NORMALIZED MESSAGE:', normalizedMsg);

    if (isNoiseMessage(rawMsg)) {
      return res.json({
        ok: true,
        reply_text: '',
        status: 'silent',
        next_step_label: 'none',
        extracted: {},
        internal_note: 'Noise ignored',
        memory_updates: {
          last_intent: String(body.last_intent || ''),
          last_question_context: String(body.last_question_context || ''),
          last_bot_reply: lastBotReply
        }
      });
    }

    const userContext = `
Nombre del usuario: ${firstName || 'No disponible'}
Mensaje actual del usuario: ${rawMsg}
Última respuesta del bot: ${lastBotReply || 'Ninguna'}
Último intent guardado: ${body.last_intent || 'Ninguno'}
Último contexto guardado: ${body.last_question_context || 'Ninguno'}
`;

    const aiResponse = await openai.responses.create({
      model: config.openAiModel,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: buildSystemPrompt() }]
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: userContext }]
        }
      ]
    });

    const rawText = aiResponse.output_text?.trim();

    if (!rawText) {
      throw new Error('No AI response returned.');
    }

    let parsed;

    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = {
        reply_text: rawText,
        status: 'continue',
        next_step_label: 'info_requested',
        internal_note: 'AI returned plain text',
        memory_updates: {
          last_intent: 'general',
          last_question_context: 'general',
          last_bot_reply: rawText
        }
      };
    }

    const replyText = String(parsed.reply_text || '').trim();

    return res.json({
      ok: true,
      reply_text: replyText,
      status: parsed.status || 'continue',
      next_step_label: parsed.next_step_label || 'info_requested',
      extracted: {},
      internal_note: parsed.internal_note || 'AI handled response',
      owner_phone: config.escalationPhone,
      memory_updates: {
        last_intent: parsed.memory_updates?.last_intent || 'general',
        last_question_context: parsed.memory_updates?.last_question_context || 'general',
        last_bot_reply: replyText
      }
    });
  } catch (error) {
    console.error('Webhook error:', error);

    return res.status(500).json({
      ok: false,
      reply_text: 'Gracias. Dame un momento y te respondo ahora mismo.',
      status: 'handoff',
      next_step_label: 'handoff_human',
      extracted: {},
      internal_note: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.listen(config.port, () => {
  console.log(`Lead automation backend listening on port ${config.port}`);
});
