const AUTH_HEADER = /authorization\s*[:=]\s*(?:bearer|basic|api[-_]?key)?\s*[^\s"';,]+/gi;
const BEARER = /\b(Bearer|Basic|Api[-_]?Key)\s+[A-Za-z0-9._~+/=-]{4,}/gi;
const KEY_LIKE = /\b(sk|rk|pk|ak)-[A-Za-z0-9_-]{8,}\b/g;
const MAX_LEN = 2048;

/** 脱敏任意文本：用于日志、错误与警告（基线 §8） */
export function redactText(input: string): string {
  return input
    .replace(AUTH_HEADER, 'authorization=[REDACTED]')
    .replace(BEARER, '$1 [REDACTED]')
    .replace(KEY_LIKE, '[REDACTED]');
}

/** 供应商错误体：先脱敏再截断，然后才允许进入日志（基线 §8/§12） */
export function redactProviderErrorBody(body: unknown): string {
  let text: string;
  try {
    text = typeof body === 'string' ? body : JSON.stringify(body);
  } catch {
    text = String(body);
  }
  return redactText(text).slice(0, MAX_LEN);
}
