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

app.post('/webhooks/manychat', async (req, res) => {
  try {
    const payload = inboundSchema.parse(req.body);

    if (payload.secret !== config.webhookSecret) {
      return res.status(401).json({ ok: false, error: 'Invalid secret.' });
    }
const msg = String(payload.last_user_message || '').toLowerCase();
const stage = String(payload.lead_stage || '').toLowerCase();

const hasBudget =
  /\d/.test(msg) || msg.includes('millon') || msg.includes('millón') || msg.includes('millones');

const hasIntent =
  msg.includes('vivir') || msg.includes('invertir') || msg.includes('inversion') || msg.includes('inversión');

const wantsVisit =
  msg.includes('ver') || msg.includes('visita') || msg.includes('interesa') || msg.includes('quiero') || msg.includes('si') || msg.includes('sí');

if (payload.lead_type === 'buyer') {
  if (hasIntent) {
    const isInvestor = msg.includes('invertir') || msg.includes('inversion') || msg.includes('inversión');

    return res.json({
      ok: true,
      reply_text: isInvestor
        ? 'Buenísimo 👌 Como inversión tiene potencial porque está en obra gris y puedes terminarla con estrategia. ¿Te gustaría verla en persona?'
        : 'Perfecto 👌 Para vivir puede ser una buena opción porque la terminas a tu gusto. ¿Te gustaría verla en persona?',
      status: 'continue',
      next_step_label: 'visit_interest',
      extracted: {},
      internal_note: 'Forced intent logic',
      owner_phone: config.escalationPhone
    });
  }

  if (hasBudget) {
    return res.json({
      ok: true,
      reply_text: 'Perfecto 🔥 Ese presupuesto encaja. ¿La buscas para vivir o para invertir?',
      status: 'continue',
      next_step_label: 'ask_intent',
      extracted: {},
      internal_note: 'Forced budget logic',
      owner_phone: config.escalationPhone
    });
  }

  if (stage === 'visit_interest' && wantsVisit) {
    return res.json({
      ok: true,
      reply_text: 'Perfecto 🔥 ¿Qué día te queda mejor para coordinar la visita?',
      status: 'continue',
      next_step_label: 'schedule_visit',
      extracted: {},
      internal_note: 'Forced visit logic',
      owner_phone: config.escalationPhone
    });
  }
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

const parsed = JSON.parse(rawText);

// Force stage progression for buyer leads
let forcedNextStep = parsed.next_step_label;
let forcedReply = parsed.reply_text;


if (payload.lead_type === 'buyer') {
  if ((stage === 'ask_budget' || stage === '' || stage === 'unknown') && hasBudget) {
    forcedNextStep = 'ask_intent';
    forcedReply = 'Perfecto 🔥 Ese presupuesto encaja. ¿La buscas para vivir o para invertir?';
  }

  if (hasIntent) {
    forcedNextStep = 'visit_interest';

    if (msg.includes('invertir') || msg.includes('inversion') || msg.includes('inversión')) {
      forcedReply = 'Buenísimo 👌 Como inversión tiene potencial porque está en obra gris y puedes terminarla con estrategia. ¿Te gustaría verla en persona?';
    } else {
      forcedReply = 'Perfecto 👌 Para vivir puede ser una buena opción porque la terminas a tu gusto. ¿Te gustaría verla en persona?';
    }
  }

  if (stage === 'visit_interest' && wantsVisit) {
    forcedNextStep = 'schedule_visit';
    forcedReply = 'Perfecto 🔥 ¿Qué día te queda mejor para coordinar la visita?';
  }
}

const finalReply = parsed.status === 'handoff'
  ? buildHandoffMessage(payload.lead_type)
  : forcedReply;

    return res.json({
      ok: true,
      reply_text: finalReply,
      status: parsed.status,
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
