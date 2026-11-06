import { BAYZE_API_BILLING_URL } from '../config/schema.js';
import { isLocalOrPrivateHost } from '../config/schema.js';

/**
 * Bayze API 余额查询（P1 商业闭环）：
 * GET /v1/balance（Bearer lw- key）→ { balance, allowance?, allowance_expires_at? }
 * 平台端点上线前对 404 优雅降级（指引用户去控制台钱包页）。
 */

export interface BalanceInfo {
  /** 剩余点数（同控制台钱包口径） */
  balance: number;
  /** 月度套餐桶剩余（无套餐为 null） */
  allowance: number | null;
  allowanceExpiresAt: string | null;
}

export type BalanceResult =
  | { ok: true; info: BalanceInfo }
  | { ok: false; code: 'invalid_key' | 'endpoint_unavailable' | 'network' | 'unexpected'; message: string };

/** 纯解析：状态码 + 响应体 → 结果（离线可测） */
export function parseBalanceResponse(status: number, body: unknown): BalanceResult {
  if (status === 200) {
    const obj = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined;
    // 兼容 balance / points_balance 两种字段名
    const raw = typeof obj?.['balance'] === 'number' ? obj['balance'] : typeof obj?.['points_balance'] === 'number' ? obj['points_balance'] : undefined;
    if (raw === undefined) {
      return { ok: false, code: 'unexpected', message: `balance field missing in response: ${JSON.stringify(body).slice(0, 200)}` };
    }
    return {
      ok: true,
      info: {
        balance: raw,
        allowance: typeof obj?.['allowance'] === 'number' ? obj['allowance'] : null,
        allowanceExpiresAt: typeof obj?.['allowance_expires_at'] === 'string' ? obj['allowance_expires_at'] : null,
      },
    };
  }
  const errText = typeof body === 'object' && body !== null
    ? String((body as Record<string, unknown>)['error'] ?? JSON.stringify(body).slice(0, 200))
    : String(body).slice(0, 200);
  if (status === 401) return { ok: false, code: 'invalid_key', message: errText };
  if (status === 404) return { ok: false, code: 'endpoint_unavailable', message: errText };
  return { ok: false, code: 'unexpected', message: `status ${status}: ${errText}` };
}

const BALANCE_URL = 'https://app.lanwealth.com/v1/balance';

/** 出站 URL 安全校验：仅 https 且非本地/私有主机（Mimosa 约束 2026-11-06） */
function assertOutboundUrl(url: string): void {
  const u = new URL(url);
  if (u.protocol !== 'https:' || isLocalOrPrivateHost(u.hostname)) {
    throw new Error(`refusing outbound request to ${u.protocol}//${u.hostname} (https + public host required)`);
  }
}

/** 拉取余额（固定平台端点；超时 10s；错误体不透传密钥） */
export async function fetchBayzeBalance(apiKey: string): Promise<BalanceResult> {
  assertOutboundUrl(BALANCE_URL);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(BALANCE_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ac.signal,
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, code: 'unexpected', message: `non-JSON response: ${text.slice(0, 200)}` };
    }
    return parseBalanceResponse(res.status, parsed);
  } catch (e) {
    return { ok: false, code: 'network', message: `request failed: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 终端展示行（与错误分流解耦，便于测试） */
export function formatBalanceLines(r: BalanceResult, keyRef: string): string[] {
  if (r.ok) {
    const lines = [`Bayze API balance: ${r.info.balance} points`];
    if (r.info.allowance !== null) {
      lines.push(`Monthly plan allowance: ${r.info.allowance} points${r.info.allowanceExpiresAt ? ` (expires ${r.info.allowanceExpiresAt})` : ''}`);
    }
    lines.push(`Top up: ${BAYZE_API_BILLING_URL}`);
    return lines;
  }
  switch (r.code) {
    case 'invalid_key':
      return [`Invalid API key (${r.message}). Check the key behind ${keyRef} at the console: ${BAYZE_API_BILLING_URL}`];
    case 'endpoint_unavailable':
      return [
        'Balance endpoint not available yet on the platform.',
        `Check your wallet in the console for now: ${BAYZE_API_BILLING_URL}`,
      ];
    default:
      return [`Failed to fetch balance: ${r.message}`];
  }
}
