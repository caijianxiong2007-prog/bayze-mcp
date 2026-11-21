import { err, ok } from '../../domain/errors.js';
import type { Result } from '../../domain/errors.js';

/** 评审者逐条核查记录（v1.4.2 / claims_checked）：
 *  评论者提出的盲区——跨厂商复核拦不住「共享源材料里的错误」，除非评审者显式列出
 *  自己核查过哪些断言、依据哪份材料。source 是评审者自报的出处（模型意见，非事实保证）。 */
export interface ClaimChecked {
  /** 被核查的断言（草稿/任务中的原文片段或概括） */
  claim: string;
  /** 核查依据：draft / task / source_material / NOT_FOUND / 其他自报值 */
  source: string;
}

export interface ReviewVerdict {
  verdict: 'accept' | 'revise';
  reasons: string[];
  /** 仅当 review_schema 含 claims_checked 时解析；缺失时为 undefined（不强制，避免橡皮图章化） */
  claimsChecked?: ClaimChecked[];
}

export type ReviewParseError =
  | { code: 'unparseable'; message: string }
  | { code: 'invalid_verdict'; message: string }
  | { code: 'invalid_reasons'; message: string }
  | { code: 'invalid_claims_checked'; message: string };

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
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every((x) => typeof x === 'string')) {
      return err({ code: 'invalid_reasons', message: 'reviewer reasons must be a non-empty array of strings (empty reasons = rubber-stamp, fails closed)' });
    }
    reasons = raw as string[];
  }
  let claimsChecked: ClaimChecked[] | undefined;
  if (schemaFields.includes('claims_checked')) {
    const raw = obj['claims_checked'];
    if (raw === undefined) {
      // 不强制：评审者可能判定无可核查断言；缺失不 fail（避免为了过闸编造清单）
      claimsChecked = undefined;
    } else if (!Array.isArray(raw)) {
      return err({ code: 'invalid_claims_checked', message: 'claims_checked must be an array (string or {claim, source} entries) when present' });
    } else {
      const out: ClaimChecked[] = [];
      for (const item of raw) {
        if (typeof item === 'string' && item.trim() !== '') {
          out.push({ claim: item.trim(), source: 'unspecified' });
        } else if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>)['claim'] === 'string' && ((item as Record<string, unknown>)['claim'] as string).trim() !== '') {
          const o = item as Record<string, unknown>;
          const source = typeof o['source'] === 'string' && o['source'].trim() !== '' ? o['source'].trim() : 'unspecified';
          out.push({ claim: (o['claim'] as string).trim(), source });
        } else {
          return err({ code: 'invalid_claims_checked', message: 'each claims_checked entry must be a non-empty string or an object with a non-empty "claim" string' });
        }
      }
      claimsChecked = out;
    }
  }
  return ok({ verdict, reasons, ...(claimsChecked !== undefined ? { claimsChecked } : {}) });
}

function extractJson(content: string): string | undefined {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced?.[1] ?? content;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}
