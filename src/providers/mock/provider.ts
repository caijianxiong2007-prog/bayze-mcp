import { err, ok } from '../../domain/errors.js';
import type { Result } from '../../domain/errors.js';
import type { ProviderErrorCode, Usage } from '../../domain/types.js';
import type {
  AdapterCapabilities,
  ProviderAdapter,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderError,
} from '../types.js';

/**
 * Mock adapter（基线 §5）：无密钥、无网络，按模型 id 映射确定性场景，
 * 覆盖 成功 / 空输出 / 超时 / 限流 / 各类供应商错误 / 可中止挂起 路径。
 */

type Scenario =
  | 'success'
  | 'review_accept'
  | 'review_revise'
  | 'empty'
  | 'timeout'
  | 'rate_limit'
  | 'auth'
  | 'network'
  | 'invalid_request'
  | 'provider_unavailable'
  | 'content_blocked'
  | 'unknown'
  | 'hang';

const SCENARIOS: Record<string, Scenario> = {
  'mock-success': 'success',
  'mock-review-accept': 'review_accept',
  'mock-review-revise': 'review_revise',
  'mock-empty': 'empty',
  'mock-timeout': 'timeout',
  'mock-rate-limit': 'rate_limit',
  'mock-auth': 'auth',
  'mock-network': 'network',
  'mock-invalid-request': 'invalid_request',
  'mock-unavailable': 'provider_unavailable',
  'mock-blocked': 'content_blocked',
  'mock-unknown': 'unknown',
  'mock-hang': 'hang',
};

/** 仅明确可重试的类别标记 retryable（基线 §6） */
const RETRYABLE: Partial<Record<ProviderErrorCode, boolean>> = {
  rate_limit: true,
  network: true,
};

const FAILURE_SCENARIOS: Partial<Record<Scenario, ProviderErrorCode>> = {
  timeout: 'timeout',
  rate_limit: 'rate_limit',
  auth: 'auth',
  network: 'network',
  invalid_request: 'invalid_request',
  provider_unavailable: 'provider_unavailable',
  content_blocked: 'content_blocked',
  unknown: 'unknown',
};

export class MockProvider implements ProviderAdapter {
  readonly kind = 'mock' as const;

  constructor(readonly providerId: string) {}

  capabilities(): AdapterCapabilities {
    return { streaming: false, json: true, tools: false, vision: false };
  }

  async chat(req: ProviderChatRequest): Promise<Result<ProviderChatResponse, ProviderError>> {
    const scenario = scenarioFor(req.modelId);

    if (scenario === 'hang') {
      // 挂起直到超时或外部中止：用于取消传播测试（基线 §3）
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, req.timeoutMs);
        req.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return this.fail('timeout', `mock: model ${req.modelId} timed out after ${req.timeoutMs}ms`);
    }

    const failureCode = FAILURE_SCENARIOS[scenario];
    if (failureCode) {
      return this.fail(
        failureCode,
        `mock: model ${req.modelId} simulated ${failureCode}`,
        scenario === 'rate_limit' ? 10 : undefined,
      );
    }

    const content =
      scenario === 'empty'
        ? ''
        : scenario === 'review_accept'
          ? JSON.stringify({ verdict: 'accept', reasons: ['mock reviewer accepted the draft'] })
          : scenario === 'review_revise'
            ? JSON.stringify({ verdict: 'revise', reasons: ['mock reviewer requested one revision'] })
            : `MOCK_OK[${req.modelId}] deterministic reply (${inputChars(req)} chars of input).`;

    const usage: Usage = { inputTokens: Math.max(1, Math.ceil(inputChars(req) / 4)), outputTokens: 32 };
    return ok({ content, usage, providerModelId: req.modelId });
  }

  private fail(
    code: ProviderErrorCode,
    message: string,
    retryAfterMs?: number,
  ): Result<ProviderChatResponse, ProviderError> {
    const retryable = RETRYABLE[code] ?? false;
    const error: ProviderError =
      retryAfterMs !== undefined ? { code, message, retryable, retryAfterMs } : { code, message, retryable };
    return err(error);
  }
}

function scenarioFor(modelId: string): Scenario {
  return SCENARIOS[modelId] ?? 'success';
}

function inputChars(req: ProviderChatRequest): number {
  return (req.system ?? '').length + req.user.length;
}
