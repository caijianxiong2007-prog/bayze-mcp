import { err, ok } from '../../domain/errors.js';
import type { Result } from '../../domain/errors.js';
import type { Usage } from '../../domain/types.js';
import { redactProviderErrorBody } from '../../logging/redact.js';
import type { CredentialStore } from '../../credentials/store.js';
import type { AnthropicProviderConfig } from '../../config/schema.js';
import { endpointUrl, postJson } from '../common/http.js';
import { parseRetryAfterMs } from '../openai-compatible/adapter.js';
import type { AdapterCapabilities, ProviderAdapter, ProviderChatRequest, ProviderChatResponse, ProviderError } from '../types.js';

/**
 * Anthropic Messages 适配器（独立适配器，基线 §5：协议/鉴权/错误体系与 OpenAI 兼容均不同）：
 * POST {base_url}/v1/messages，x-api-key + anthropic-version 头，错误体为 {type:'error',error:{type,message}}。
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = 'anthropic' as const;

  constructor(
    readonly providerId: string,
    private readonly cfg: AnthropicProviderConfig,
    private readonly creds: CredentialStore,
  ) {}

  capabilities(): AdapterCapabilities {
    return { streaming: false, json: false, tools: false, vision: false };
  }

  async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
    const key = this.creds.resolve(this.cfg.api_key_ref);
    if (!key.ok) {
      return err({ code: 'auth', message: `credential ref unresolved: ${key.error.message}`, retryable: false });
    }

    const body: Record<string, unknown> = {
      model: req.modelId,
      max_tokens: req.maxOutputTokens,
      messages: [{ role: 'user', content: req.user }],
    };
    if (req.system !== undefined) body['system'] = req.system;

    const path = this.cfg.base_url.endsWith('/v1') ? '/messages' : '/v1/messages';
    const res = await postJson({
      url: endpointUrl(this.cfg.base_url, path),
      headers: { 'x-api-key': key.value, 'anthropic-version': '2023-06-01' },
      body,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    });
    if (!res.ok) {
      const e = res.error;
      const mapped: ProviderError =
        e.code === 'timeout'
          ? { code: 'timeout', message: e.message, retryable: false }
          : e.code === 'network'
            ? { code: 'network', message: e.message, retryable: true }
            : { code: 'unknown', message: e.message, retryable: false };
      return err(mapped);
    }

    const { status, body: respBody } = res.value;
    if (status === 200) {
      const obj = asObject(respBody);
      const contentBlocks = Array.isArray(obj?.['content']) ? (obj['content'] as unknown[]) : [];
      const text = contentBlocks
        .map((b) => {
          const block = asObject(b);
          return block?.['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : '';
        })
        .join('');
      const usageRaw = asObject(obj?.['usage']);
      const usage: Usage | undefined =
        typeof usageRaw?.['input_tokens'] === 'number' && typeof usageRaw['output_tokens'] === 'number'
          ? { inputTokens: usageRaw['input_tokens'], outputTokens: usageRaw['output_tokens'] }
          : undefined;
      const providerModelId = typeof obj?.['model'] === 'string' ? obj['model'] : undefined;
      return ok({ content: text, usage, providerModelId });
    }

    // Anthropic 错误体：{type:'error', error:{type, message}}
    const errObj = asObject(asObject(respBody)?.['error']);
    const errType = typeof errObj?.['type'] === 'string' ? errObj['type'] : '';
    const errText = redactProviderErrorBody(errObj?.['message'] ?? respBody);
    const retryAfterMs = parseRetryAfterMs(res.value.headers);

    if (errType === 'authentication_error' || errType === 'permission_error' || status === 401 || status === 403) {
      return err({ code: 'auth', message: `${errType || status}: ${errText}`, retryable: false });
    }
    if (errType === 'rate_limit_error' || status === 429) {
      return err(
        retryAfterMs !== undefined
          ? { code: 'rate_limit', message: `${errType || status}: ${errText}`, retryable: true, retryAfterMs }
          : { code: 'rate_limit', message: `${errType || status}: ${errText}`, retryable: true },
      );
    }
    if (errType === 'overloaded_error' || status === 529 || status >= 500) {
      return err({ code: 'provider_unavailable', message: `${errType || status}: ${errText}`, retryable: true });
    }
    if (errType === 'invalid_request_error' || status === 400 || status === 422) {
      return err({ code: 'invalid_request', message: `${errType || status}: ${errText}`, retryable: false });
    }
    return err({ code: 'unknown', message: `${errType || status}: ${errText}`, retryable: false });
  }
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
