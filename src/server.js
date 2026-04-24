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

    if (payload.secret !== config.webhookSecret) {
      return res.status(401).json({ ok: false, error: 'Invalid secret.' });
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
    const nextStep = detectNextStage(payload, parsed.next_step_label);

    const finalReply =
      parsed.status === 'handoff' || nextStep === 'handoff_human'
        ? buildHandoffMessage(payload.lead_type)
        : parsed.reply_text;

    return res.json({
      ok: true,
      reply_text: finalReply,
      status: nextStep === 'handoff_human' ? 'handoff' : parsed.status,
      next_step_label: nextStep,
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
