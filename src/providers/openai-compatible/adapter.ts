import { err, ok } from '../../domain/errors.js';
import type { Result } from '../../domain/errors.js';
import type { Usage } from '../../domain/types.js';
import { redactProviderErrorBody } from '../../logging/redact.js';
import type { CredentialStore } from '../../credentials/store.js';
import type { RemoteProviderConfig } from '../../config/schema.js';
import { endpointUrl, postJson } from '../common/http.js';
import type { AdapterCapabilities, ProviderAdapter, ProviderChatRequest, ProviderChatResponse, ProviderError } from '../types.js';

/**
 * OpenAI 兼容适配器：POST {base_url}/chat/completions，Bearer 鉴权。
 * 凭证仅在调用时从环境变量解析（基线 §8）；错误体脱敏后才进入错误消息。
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly kind = 'openai-compatible' as const;

  constructor(
    readonly providerId: string,
    private readonly cfg: RemoteProviderConfig,
    private readonly creds: CredentialStore,
  ) {}

  /** 如实声明（基线 §10.7）：P0 仅实现非流式纯文本 chat */
  capabilities(): AdapterCapabilities {
    return { streaming: false, json: false, tools: false, vision: false };
  }

  async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
    const key = this.creds.resolve(this.cfg.api_key_ref);
    if (!key.ok) {
      return err({ code: 'auth', message: `credential ref unresolved: ${key.error.message}`, retryable: false });
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (req.system !== undefined) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.user });

    const res = await postJson({
      url: endpointUrl(this.cfg.base_url, '/chat/completions'),
      headers: { authorization: `Bearer ${key.value}` },
      body: { model: req.modelId, messages, max_tokens: req.maxOutputTokens, stream: false },
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    });
    if (!res.ok) return err(mapTransportError(res.error.code, res.error.message));

    const { status, body } = res.value;
    if (status === 200) {
      const obj = asObject(body);
      const choices = Array.isArray(obj?.['choices']) ? (obj['choices'] as unknown[]) : [];
      const first = asObject(choices[0]);
      const message = asObject(first?.['message']);
      const content = message?.['content'];
      if (typeof content !== 'string') {
        return err({ code: 'unknown', message: `unexpected response shape: ${redactProviderErrorBody(body)}`, retryable: false });
      }
      const usageRaw = asObject(obj?.['usage']);
      const usage: Usage | undefined =
        typeof usageRaw?.['prompt_tokens'] === 'number' && typeof usageRaw['completion_tokens'] === 'number'
          ? { inputTokens: usageRaw['prompt_tokens'], outputTokens: usageRaw['completion_tokens'] }
          : undefined;
      const providerModelId = typeof obj?.['model'] === 'string' ? obj['model'] : undefined;
      return ok({ content, usage, providerModelId });
    }
    return err(mapProviderStatus(status, body, res.value.headers));
  }
}

export function mapProviderStatus(status: number, body: unknown, headers: Headers): ProviderError {
  const errText = redactProviderErrorBody(asObject(body)?.['error'] ?? body);
  const retryAfterMs = parseRetryAfterMs(headers);
  if (status === 401 || status === 403) {
    return { code: 'auth', message: `status ${status}: ${errText}`, retryable: false };
  }
  if (status === 429) {
    return retryAfterMs !== undefined
      ? { code: 'rate_limit', message: `status 429: ${errText}`, retryable: true, retryAfterMs }
      : { code: 'rate_limit', message: `status 429: ${errText}`, retryable: true };
  }
  if (status === 408) {
    return { code: 'timeout', message: `status 408: ${errText}`, retryable: false };
  }
  if (status === 400 || status === 422) {
    const blocked = /content|policy|filter|safety/i.test(errText);
    return { code: blocked ? 'content_blocked' : 'invalid_request', message: `status ${status}: ${errText}`, retryable: false };
  }
  if (status >= 500) {
    return { code: 'provider_unavailable', message: `status ${status}: ${errText}`, retryable: true };
  }
  return { code: 'unknown', message: `status ${status}: ${errText}`, retryable: false };
}

function mapTransportError(code: 'timeout' | 'network' | 'response_too_large' | 'redirect_refused' | 'invalid_response', message: string): ProviderError {
  if (code === 'timeout') return { code: 'timeout', message, retryable: false };
  if (code === 'network') return { code: 'network', message, retryable: true };
  return { code: 'unknown', message, retryable: false };
}

export function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, 60_000);
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
