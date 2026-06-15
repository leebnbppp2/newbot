/**
 * Unified error envelope (PHASE_42_2_SIGNER_API.md §8).
 * Every non-2xx response carries `{ error: { code, message, retryable } }`.
 */

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export function errorEnvelope(code: string, message: string, retryable: boolean): ErrorEnvelope {
  return { error: { code, message, retryable } };
}

const HTTP_FOR_CODE: Record<string, number> = {
  INSUFFICIENT_BALANCE: 402,
  INSUFFICIENT_ALLOWANCE: 409,
  CREDS_NOT_READY: 409,
  GEOBLOCKED: 451,
  ORDER_REJECTED: 422,
  SIGNING_FAILED: 500,
  UPSTREAM_TIMEOUT: 504,
  SIGNER_LIVE_NOT_IMPLEMENTED: 501,
  UNAUTHORIZED: 401,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
};

export function httpStatusForCode(code: string): number {
  return HTTP_FOR_CODE[code] ?? 500;
}
