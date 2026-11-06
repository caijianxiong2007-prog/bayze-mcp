import type { CheckResult } from '../../domain/types.js';
import type { CheckSpec } from '../../config/schema.js';

/**
 * 确定性检查（基线 §5/§7）：只做结构/长度判定，不判定内容质量。
 * max_words 按空白分词计数（面向英文等空格分隔语言；中文无空格会算 1 词，
 * 中文请用 max_chars）——dogfood 四次证实模型报字数系统性不可信，词数约束交给引擎。
 */
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
    if ('max_words' in spec) {
      const words = content.trim().length === 0 ? 0 : content.trim().split(/\s+/).length;
      const passed = words <= spec.max_words;
      return {
        checkId: 'max_words',
        passed,
        detail: passed ? undefined : `word count ${words} exceeds max_words ${spec.max_words}`,
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
