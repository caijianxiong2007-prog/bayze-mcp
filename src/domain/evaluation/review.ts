import { err, ok } from '../../domain/errors.js';
import type { Result } from '../../domain/errors.js';

export interface ReviewVerdict {
  verdict: 'accept' | 'revise';
  reasons: string[];
}

export type ReviewParseError =
  | { code: 'unparseable'; message: string }
  | { code: 'invalid_verdict'; message: string }
  | { code: 'invalid_reasons'; message: string };

/**
 * 解析 reviewer 输出（基线 §7）：
 * 无法解析、verdict 非法或 schema 要求的字段缺失/类型不符 → 一律 fail-closed 报错，
 * 由编排器停止工作流；绝不默认 accept。
 */
export function parseReview(content: string, schemaFields: string[]): Result<ReviewVerdict, ReviewParseError> {
  const jsonText = extractJson(content);
  if (jsonText === undefined) {
    return err({ code: 'unparseable', message: 'reviewer output contains no JSON object' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return err({ code: 'unparseable', message: 'reviewer output is not valid JSON' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err({ code: 'unparseable', message: 'reviewer output is not a JSON object' });
  }
  const obj = parsed as Record<string, unknown>;
  const verdict = obj['verdict'];
  if (verdict !== 'accept' && verdict !== 'revise') {
    return err({ code: 'invalid_verdict', message: 'reviewer verdict must be "accept" or "revise"' });
  }
  let reasons: string[] = [];
  if (schemaFields.includes('reasons')) {
    const raw = obj['reasons'];
    if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
      return err({ code: 'invalid_reasons', message: 'reviewer reasons must be an array of strings' });
    }
    reasons = raw as string[];
  }
  return ok({ verdict, reasons });
}

function extractJson(content: string): string | undefined {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced?.[1] ?? content;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}
