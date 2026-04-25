import { z } from 'zod';

export const inboundSchema = z.object({
  secret: z.string(),
  channel: z.enum(['instagram', 'facebook', 'whatsapp']).default('instagram'),
  lead_type: z.enum(['buyer', 'agent']),
  user_id: z.string().min(1),
  user_name: z.string().optional().default(''),
  last_user_message: z.string().min(1),
  lead_stage: z.string().optional().default('unknown'),
  last_intent: z.string().optional().default(''),
  last_question_context: z.string().optional().default(''),
  last_bot_reply: z.string().optional().default(''),
  context: z
    .object({
      previous_answers: z.record(z.string()).optional().default({}),
      property_summary: z.string().optional().default(''),
      service_summary: z.string().optional().default('')
    })
    .optional()
    .default({ previous_answers: {}, property_summary: '', service_summary: '' })
});

export function buildConversationInput(payload) {
  const { lead_type, user_name, channel, last_user_message, lead_stage, context } = payload;

  const knownFacts = Object.entries(context.previous_answers || {})
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n');

  return [
    `Lead type: ${lead_type}`,
    `Channel: ${channel}`,
    `Lead name: ${user_name || 'Unknown'}`,
    `Current stage: ${lead_stage || 'unknown'}`,
    '',
    context.property_summary ? `Property summary:\n${context.property_summary}\n` : '',
    context.service_summary ? `Service summary:\n${context.service_summary}\n` : '',
    knownFacts ? `Known answers:\n${knownFacts}\n` : '',
    `Latest message from lead:\n${last_user_message}`
  ].join('\n');
}

export function buildHandoffMessage(leadType, visitTime = '') {
  if (leadType === 'buyer') {
    const cleanVisitTime = String(visitTime || '').trim();

    if (cleanVisitTime) {
      return `Perfecto 🔥 Queda anotado para ${cleanVisitTime}.

Te escribo ahora por WhatsApp con la ubicación y los detalles de la visita.`;
    }

    return `Perfecto 🔥 Queda anotado.

Te escribo ahora por WhatsApp con la ubicación y los detalles de la visita.`;
  }

  return 'Perfecto. Ya tengo lo principal. Te paso con la persona para explicarte cómo aplicaríamos esto contigo.';
}
