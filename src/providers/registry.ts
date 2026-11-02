import { err, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { ProviderConfig } from '../config/schema.js';
import { MockProvider } from './mock/provider.js';
import type { ProviderAdapter } from './types.js';

export interface RegistryError {
  code: 'not_implemented' | 'unknown_kind';
  message: string;
}

/** 按配置创建 adapter。真实协议适配器（openai-compatible 等）在阶段 4 注册（基线 §11）。 */
export function createProvider(providerId: string, cfg: ProviderConfig): Result<ProviderAdapter, RegistryError> {
  switch (cfg.kind) {
    case 'mock':
      return ok(new MockProvider(providerId));
    case 'openai-compatible':
      return err({
        code: 'not_implemented',
        message: `provider "${providerId}": openai-compatible adapter ships in stage 4`,
      });
    default:
      return err({ code: 'unknown_kind', message: `provider "${providerId}": unsupported kind` });
  }
}
