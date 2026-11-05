import { err, ok } from '../../domain/errors.js';
import type { Result } from '../../domain/errors.js';
import type { Usage } from '../../domain/types.js';
import { redactProviderErrorBody } from '../../logging/redact.js';
import type { CredentialStore } from '../../credentials/store.js';
import type { GeminiProviderConfig } from '../../config/schema.js';
import { endpointUrl, postJson } from '../common/http.js';
import { parseRetryAfterMs } from '../openai-compatible/adapter.js';
import type { AdapterCapabilities, ProviderAdapter, ProviderChatRequest, ProviderChatResponse, ProviderError } from '../types.js';

/**
 * Google Gemini 适配器（P2-⑤）：
 * 协议：POST {base_url}/v1beta/models/{model}:generateContent
 * 鉴权：x-goog-api-key 头
 * 错误体系：HTTP 状态码 + Google 错误 JSON
 */
export class GeminiAdapter implements ProviderAdapter {
  readonly kind = 'gemini' as const;

  constructor(
    readonly providerId: string,
    private readonly cfg: GeminiProviderConfig,
    private readonly creds: CredentialStore,
  ) {}

  capabilities(): AdapterCapabilities {
    return { streaming: false, json: true, tools: true, vision: true };
  }

  async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
    const key = this.creds.resolve(this.cfg.api_key_ref);
    if (!key.ok) {
      return err({ code: 'auth', message: `credential ref unresolved: ${key.error.message}`, retryable: false });
    }

    const path = `/v1beta/models/${encodeURIComponent(req.modelId)}:generateContent`;
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      generationConfig: {
        maxOutputTokens: req.maxOutputTokens,
      },
    };

    const res = await postJson({
      url: endpointUrl(this.cfg.base_url, path),
      headers: { 'x-goog-api-key': key.value },
      body,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    });
    if (!res.ok) {
      const e = res.error;
      const mapped: ProviderError =
        e.code === 'timeout' ? { code: 'timeout', message: e.message, retryable: false }
        : e.code === 'network' ? { code: 'network', message: e.message, retryable: true }
        : { code: 'unknown', message: e.message, retryable: false };
      return err(mapped);
    }

    const { status, body: respBody } = res.value;
    if (status === 200) {
      const obj = asObject(respBody);
      const candidates = Array.isArray(obj?.['candidates']) ? obj['candidates'] : [];
      const first = asObject(candidates[0]);
      const content = asObject(first?.['content']);
      const parts = Array.isArray(content?.['parts']) ? content['parts'] : [];
      const text = parts
        .map((p) => { const part = asObject(p); return typeof part?.['text'] === 'string' ? part['text'] : ''; })
        .join('');
      const usageRaw = asObject(obj?.['usageMetadata']);
      const usage: Usage | undefined =
        typeof usageRaw?.['promptTokenCount'] === 'number' && typeof usageRaw?.['candidatesTokenCount'] === 'number'
          ? { inputTokens: usageRaw['promptTokenCount'], outputTokens: usageRaw['candidatesTokenCount'] }
          : undefined;
      const providerModelId = typeof obj?.['modelVersion'] === 'string' ? obj['modelVersion'] : undefined;
      return ok({ content: text, usage, providerModelId });
    }

    // 错误映射
    const errObj = asObject(asObject(respBody)?.['error']);
    const errText = redactProviderErrorBody(errObj?.['message'] ?? respBody);
    const retryAfterMs = parseRetryAfterMs(res.value.headers);
    if (status === 401 || status === 403) {
      return err({ code: 'auth', message: `status ${status}: ${errText}`, retryable: false });
    }
    if (status === 429) {
      return err(retryAfterMs !== undefined
        ? { code: 'rate_limit', message: `status 429: ${errText}`, retryable: true, retryAfterMs }
        : { code: 'rate_limit', message: `status 429: ${errText}`, retryable: true });
    }
    if (status === 400) {
      const blocked = /safety|blocked|content/i.test(errText);
      return err({ code: blocked ? 'content_blocked' : 'invalid_request', message: `status ${status}: ${errText}`, retryable: false });
    }
    if (status >= 500) {
      return err({ code: 'provider_unavailable', message: `status ${status}: ${errText}`, retryable: true });
    }
    return err({ code: 'unknown', message: `status ${status}: ${errText}`, retryable: false });
  }
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
