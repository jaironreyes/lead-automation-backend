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

/* ---------------- AI PROMPT ---------------- */

function buildSystemPrompt() {
  return `
Eres un vendedor inmobiliario por Instagram DM.

Responde como humano, dominicano, directo.

OBJETIVO:
Llevar al usuario a visita o WhatsApp.

PRECIO:
RD$4.5M (mínimo 4.3M, no ofrecer de inmediato)

WHATSAPP:
849-207-3914

REGLAS:
- Responde SOLO lo que preguntan
- Luego empuja suavemente a acción
- No párrafos largos

LEAD_STAGE (CRÍTICO):

Devuelve uno de estos EXACTAMENTE:

New Lead
Interested
Budget Qualified
Property Sent
Visit Scheduled
Visited
Negotiation

REGLAS:

- Saludo → New Lead
- Interés → Interested
- Precio/banco → Budget Qualified
- Ubicación/detalles → Property Sent
- Visita → Visit Scheduled
- Negociación → Negotiation

FORMATO:

{
  "reply_text": "texto",
  "status": "continue",
  "next_step_label": "info_requested",
  "lead_stage": "Interested",
  "internal_note": "nota",
  "memory_updates": {
    "last_intent": "intent",
    "last_question_context": "context",
    "last_bot_reply": "texto"
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

    const finalStage = normalizeStage(parsed.lead_stage);

    return res.json({
      ok: true,
      reply_text: parsed.reply_text,
      status: parsed.status || 'continue',
      next_step_label: parsed.next_step_label || 'info_requested',

      lead_stage: finalStage,

      extracted: {
        lead_stage: finalStage
      }
    });
  } catch (err) {
    console.error(err);

    return res.json({
      ok: true,
      reply_text: 'Escríbeme por WhatsApp 👉 849-207-3914',
      lead_stage: 'Interested',
      extracted: { lead_stage: 'Interested' }
    });
  }
});

app.listen(config.port, () => {
  console.log('Server running...');
});
