import { err, ok } from '../../domain/errors.js';
import type { Result } from '../../domain/errors.js';

export interface JudgeVerdict {
  /** 胜出候选的步骤名（必须命中候选集） */
  winner: string;
  reason: string;
}

export type JudgeParseError =
  | { code: 'unparseable'; message: string }
  | { code: 'invalid_winner'; message: string }
  | { code: 'invalid_reason'; message: string };

/**
 * 解析 parallel 评委输出（ADR-0006 D1）：
 * winner 必须是候选步骤名、reason 非空，否则 fail-closed——
 * 评委解析失败由编排器降级为拼接对比（评委是增强不是闸门）。
 */
export function parseJudgeVerdict(content: string, candidateNames: string[]): Result<JudgeVerdict, JudgeParseError> {
  const jsonText = extractJson(content);
  if (jsonText === undefined) {
    return err({ code: 'unparseable', message: 'judge output contains no JSON object' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return err({ code: 'unparseable', message: 'judge output is not valid JSON' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err({ code: 'unparseable', message: 'judge output is not a JSON object' });
  }
  const obj = parsed as Record<string, unknown>;
  const winner = obj['winner'];
  if (typeof winner !== 'string' || !candidateNames.includes(winner)) {
    return err({ code: 'invalid_winner', message: `judge winner must be one of: ${candidateNames.join(', ')}` });
  }
  const reason = obj['reason'];
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return err({ code: 'invalid_reason', message: 'judge reason must be a non-empty string (empty reason = rubber-stamp, fails closed)' });
  }
  return ok({ winner, reason });
}

function extractJson(content: string): string | undefined {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced?.[1] ?? content;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}
