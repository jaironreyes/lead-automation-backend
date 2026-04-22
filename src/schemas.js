export const responseJsonSchema = {
  name: 'lead_reply',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reply_text: {
        type: 'string',
        description: 'Short reply to send back to the lead.'
      },
      status: {
        type: 'string',
        enum: ['continue', 'handoff', 'stop']
      },
      extracted: {
        type: 'object',
        additionalProperties: false,
        properties: {
          budget: { type: ['string', 'null'] },
          intent: { type: ['string', 'null'] },
          area: { type: ['string', 'null'] },
          listing_count: { type: ['string', 'null'] },
          lead_source: { type: ['string', 'null'] },
          urgency: { type: ['string', 'null'] }
        },
        required: ['budget', 'intent', 'area', 'listing_count', 'lead_source', 'urgency']
      },
      next_step_label: {
        type: 'string',
        enum: ['ask_budget', 'ask_intent', 'ask_area', 'ask_listing_count', 'ask_lead_source', 'handoff_human', 'end']
      },
      internal_note: {
        type: 'string',
        description: 'Short private note for CRM or ManyChat custom field.'
      }
    },
    required: ['reply_text', 'status', 'extracted', 'next_step_label', 'internal_note']
  },
  strict: true
};
