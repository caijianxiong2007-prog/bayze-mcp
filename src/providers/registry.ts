import { err, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { ProviderConfig } from '../config/schema.js';
import { CredentialStore } from '../credentials/store.js';
import { MockProvider } from './mock/provider.js';
import { OpenAICompatibleAdapter } from './openai-compatible/adapter.js';
import { AnthropicAdapter } from './anthropic/adapter.js';
import { GeminiAdapter } from './gemini/adapter.js';
import type { ProviderAdapter } from './types.js';

export interface RegistryError {
  code: 'not_implemented' | 'unknown_kind';
  message: string;
}

/** 按配置创建 adapter（基线 §11 阶段 4：真实协议适配器注册） */
export function createProvider(providerId: string, cfg: ProviderConfig, credentials = new CredentialStore()): Result<ProviderAdapter, RegistryError> {
  switch (cfg.kind) {
    case 'mock':
      return ok(new MockProvider(providerId));
    case 'openai-compatible':
      return ok(new OpenAICompatibleAdapter(providerId, cfg, credentials));
    case 'anthropic':
      return ok(new AnthropicAdapter(providerId, cfg, credentials));
    case 'gemini':
      return ok(new GeminiAdapter(providerId, cfg, credentials));
    default:
      return err({ code: 'unknown_kind', message: `provider "${providerId}": unsupported kind` });
  }
}
