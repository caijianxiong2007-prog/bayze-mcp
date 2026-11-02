import type { ProviderErrorCode, Usage } from '../domain/types.js';
import type { Result } from '../domain/errors.js';

export type ProviderKind = 'mock' | 'openai-compatible' | 'anthropic' | 'gemini';

/** 协议级能力声明，须由契约测试验证（基线 §6）；与用户手填的 capabilities_hint 无关 */
export interface AdapterCapabilities {
  streaming: boolean;
  json: boolean;
  tools: boolean;
  vision: boolean;
}

export interface ProviderChatRequest {
  modelId: string;
  system?: string;
  user: string;
  maxOutputTokens: number;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ProviderChatResponse {
  content: string;
  usage?: Usage;
  /** 供应商回报的模型/版本标识（若有），用于审计重放 */
  providerModelId?: string;
}

export interface ProviderError {
  code: ProviderErrorCode;
  /** 必须已脱敏（基线 §8：供应商错误体先过滤后记录） */
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface ProviderAdapter {
  readonly providerId: string;
  readonly kind: ProviderKind;
  capabilities(): AdapterCapabilities;
  /** 单次对话调用；永不抛出，错误一律经 Result 返回；不负责重试与升级（基线 §3） */
  chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>>;
}
