import type { CheckResult } from '../../domain/types.js';
import type { CheckSpec } from '../../config/schema.js';

/** 确定性检查（基线 §5/§7）：只做结构/长度判定，不判定内容质量 */
export function runDeterministicChecks(content: string, specs: CheckSpec[]): CheckResult[] {
  return specs.map((spec) => {
    if (spec === 'non_empty') {
      const trimmed = content.trim().length;
      return {
        checkId: 'non_empty',
        passed: trimmed > 0,
        detail: trimmed > 0 ? undefined : `content is empty after trimming (length 0)`,
      };
    }
    const len = content.length;
    const passed = len <= spec.max_chars;
    return {
      checkId: 'max_chars',
      passed,
      detail: passed ? undefined : `content length ${len} exceeds max_chars ${spec.max_chars}`,
    };
  });
}
