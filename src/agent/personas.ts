/**
 * Persona registry. Phase 1 uses a single crypto_zh persona for webhook routing.
 */

export interface Persona {
  id: string;
  telegramBotTokenSecretName: 'BOT_TOKEN_CRYPTO_ZH';
}

export const PERSONAS: Record<string, Persona> = {
  crypto_zh: {
    id: 'crypto_zh',
    telegramBotTokenSecretName: 'BOT_TOKEN_CRYPTO_ZH',
  },
};
