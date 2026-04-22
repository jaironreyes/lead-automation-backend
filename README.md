# Lead Automation Backend

This package gives you a practical backend for:
- ManyChat inbound automation
- OpenAI-powered lead qualification
- Buyer and agent routing
- Human handoff after qualification

## What this backend does

1. Receives a webhook call from ManyChat.
2. Validates the payload with a shared secret.
3. Sends the latest message plus known context to OpenAI.
4. Forces a structured JSON response.
5. Returns a short reply, extracted lead data, and a next-step label.
6. Hands off to you when the lead is warm enough.

## Recommended architecture

### Option A — simplest production path
ManyChat -> Your Node backend -> OpenAI -> ManyChat -> Lead

### Option B — if you still want Make in the middle
ManyChat -> Make custom webhook -> Your backend or OpenAI call -> ManyChat

## Install

```bash
npm install
cp .env.example .env
npm run dev
```

## Test locally

```bash
curl -X POST http://localhost:3000/webhooks/manychat \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "replace_with_a_random_secret",
    "channel": "instagram",
    "lead_type": "buyer",
    "user_id": "ig_123",
    "user_name": "Juan",
    "last_user_message": "Estoy interesado en una casa en Santo Domingo Norte",
    "context": {
      "previous_answers": {},
      "property_summary": "Casa de 3 habitaciones, 2 baños, RD$4.5M, Santo Domingo Norte.",
      "service_summary": ""
    }
  }'
```

## Expected response

```json
{
  "ok": true,
  "reply_text": "Perfecto 🙌 ¿qué presupuesto manejas?",
  "status": "continue",
  "next_step_label": "ask_budget",
  "extracted": {
    "budget": null,
    "intent": null,
    "area": "Santo Domingo Norte",
    "listing_count": null,
    "lead_source": null,
    "urgency": null
  },
  "internal_note": "Buyer interested in Santo Domingo Norte; budget still missing.",
  "owner_phone": "+18095551234"
}
```

## Deploy

You can deploy this on:
- Render
- Railway
- Fly.io
- VPS with Node

## ManyChat mapping idea

In your ManyChat External Request action:
- Send the current lead message
- Send tags or a custom field to identify `buyer` vs `agent`
- Save response fields back into ManyChat custom fields:
  - `reply_text`
  - `status`
  - `next_step_label`
  - extracted values

Then:
- If `status = continue`, send `reply_text`
- If `status = handoff`, notify yourself and stop automation

## Important production notes

- Keep AI focused on qualification, not negotiation.
- Do not let AI invent property inventory.
- Add your real property summaries and service summaries before going live.
- Log every conversation in your CRM or spreadsheet.
