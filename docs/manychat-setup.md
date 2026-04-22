# ManyChat Setup Blueprint

This file is a practical setup guide, not an import file.

## 1. Connect channels
- Instagram Professional account
- Facebook Page
- WhatsApp Business if you have the approved setup

## 2. Create custom user fields in ManyChat
- lead_type
- budget
- intent
- area
- listing_count
- lead_source
- urgency
- internal_note
- next_step_label

## 3. Build two entry automations

### Buyer automation
Trigger keywords:
- CASA
- INFO
- PRECIO

First message:
- "Perfecto 🙌 te ayudo por aquí."

Action:
- External Request -> call your backend webhook

Payload should include:
- secret
- channel
- lead_type = buyer
- user_id
- user_name
- last_user_message
- previous answers/custom fields
- property_summary

### Agent automation
Trigger keywords:
- VIDEO
- CLIENTES
- MARKETING

First message:
- "Perfecto — te explico rápido por aquí."

Action:
- External Request -> call your backend webhook

Payload should include:
- secret
- channel
- lead_type = agent
- user_id
- user_name
- last_user_message
- previous answers/custom fields
- service_summary

## 4. Suggested ManyChat external request body
See ../examples/manychat-request-body.json

## 5. Routing inside ManyChat after the webhook
- Save JSON fields returned by your backend to custom fields.
- Send `reply_text` to the contact.
- Add a condition:
  - if status = continue -> wait for next user message and re-run
  - if status = handoff -> notify you and stop automation

## 6. Human handoff
When `status = handoff`:
- Tag the lead as HUMAN_FOLLOWUP
- Notify yourself in email, Slack, or WhatsApp
- Continue manually
