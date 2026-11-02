import type { ProviderErrorCode } from '../../domain/types.js';
import type { RunIf } from '../../config/schema.js';

/** 前一个已执行步骤的结局，驱动 run_if 判定（基线 §7 状态机） */
export type PriorOutcome =
  | { kind: 'success' }
  | { kind: 'check_failure' }
  | { kind: 'provider_error'; code: ProviderErrorCode }
  | { kind: 'review_verdict'; verdict: 'accept' | 'revise' };

/**
 * 步骤是否执行（纯函数，无副作用）：
 * - 首步总是执行
 * - always：前序成功（含评审门完成，无论结论）后执行
 * - on_check_failure：前序确定性检查失败或供应商错误（升级路径，基线 §5）
 * - review_verdict_is_revise：前一个评审门结论为 revise
 * auth 错误的立即停止由编排器处理（基线 §7：密钥错误停止，不升级）。
 */
export function isStepEligible(runIf: RunIf, prior: PriorOutcome | undefined, isFirst: boolean): boolean {
  if (isFirst) return true;
  if (!prior) return false;
  switch (runIf) {
    case 'always':
      return prior.kind === 'success' || prior.kind === 'review_verdict';
    case 'on_check_failure':
      return prior.kind === 'check_failure' || prior.kind === 'provider_error';
    case 'review_verdict_is_revise':
      return prior.kind === 'review_verdict' && prior.verdict === 'revise';
  }
}
