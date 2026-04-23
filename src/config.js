import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  openAiApiKey: requireEnv('OPENAI_API_KEY'),
  openAiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  webhookSecret: requireEnv('WEBHOOK_SECRET'),
  defaultLanguage: process.env.DEFAULT_LANGUAGE || 'es-DO',
  escalationPhone: process.env.ESCALATION_PHONE || ''
};
