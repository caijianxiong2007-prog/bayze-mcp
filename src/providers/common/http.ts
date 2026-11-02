import { err, ok } from '../../domain/errors.js';
import type { Result } from '../../domain/errors.js';

/**
 * 共享 HTTP 策略层（ADR-0001 D5 / 基线 §8）：
 * - 超时与外部取消经 AbortController 贯穿
 * - redirect: 'manual'，仅允许跟随到 HTTPS 且同主机的重定向，最多 2 跳
 * - 响应体读取设字节上限，防止资源耗尽
 */

export type HttpPolicyErrorCode = 'timeout' | 'network' | 'response_too_large' | 'redirect_refused' | 'invalid_response';

export interface HttpPolicyError {
  code: HttpPolicyErrorCode;
  message: string;
}

export interface HttpJsonResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 2;

export async function postJson(opts: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  signal: AbortSignal;
  maxResponseBytes?: number;
}): Promise<Result<HttpJsonResponse, HttpPolicyError>> {
  const originalHost = new URL(opts.url).hostname;
  let current = opts.url;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const fetched = await doFetch(current, opts);
    if (!fetched.ok) return fetched;
    const res = fetched.value;

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (hop === MAX_REDIRECT_HOPS || location === null) {
        return err({ code: 'redirect_refused', message: `redirect policy: too many redirects or missing location at ${current}` });
      }
      let target: URL;
      try {
        target = new URL(location, current);
      } catch {
        return err({ code: 'redirect_refused', message: `redirect policy: invalid location "${location}"` });
      }
      if (target.protocol !== 'https:' || target.hostname !== originalHost) {
        return err({
          code: 'redirect_refused',
          message: `redirect policy: refusing to follow to ${target.protocol}//${target.hostname} (only https + same host allowed)`,
        });
      }
      current = target.toString();
      continue;
    }

    const text = await readBounded(res, opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    if (!text.ok) return text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.value);
    } catch {
      return err({ code: 'invalid_response', message: 'response body is not valid JSON' });
    }
    return ok({ status: res.status, body: parsed, headers: res.headers });
  }
  return err({ code: 'redirect_refused', message: 'redirect policy: hop budget exhausted' });
}

async function doFetch(url: string, opts: { headers: Record<string, string>; body: unknown; timeoutMs: number; signal: AbortSignal }): Promise<Result<Response, HttpPolicyError>> {
  const ac = new AbortController();
  const propagate = () => ac.abort();
  if (opts.signal.aborted) ac.abort();
  opts.signal.addEventListener('abort', propagate, { once: true });
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify(opts.body),
      redirect: 'manual',
      signal: ac.signal,
    });
    return ok(res);
  } catch (e) {
    const reason = (e as Error)?.name === 'AbortError' || opts.signal.aborted ? 'timed out or aborted' : (e as Error).message;
    const code: HttpPolicyErrorCode = (e as Error)?.name === 'AbortError' || opts.signal.aborted ? 'timeout' : 'network';
    return err({ code, message: `request to ${url} failed: ${reason}` });
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', propagate);
  }
}

async function readBounded(res: Response, capBytes: number): Promise<Result<string, HttpPolicyError>> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > capBytes) {
    await res.body?.cancel().catch(() => {});
    return err({ code: 'response_too_large', message: `response declares ${declared} bytes, exceeding the ${capBytes} byte cap` });
  }
  if (!res.body) return ok(await res.text());
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > capBytes) {
      await reader.cancel().catch(() => {});
      return err({ code: 'response_too_large', message: `response exceeded the ${capBytes} byte cap` });
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return ok(out);
}

/** URL 拼接：base 末尾斜杠归一 */
export function endpointUrl(base: string, path: string): string {
  return base.endsWith('/') ? base + path.slice(1) : base + path;
}
