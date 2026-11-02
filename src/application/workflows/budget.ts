import { err, ok } from '../../domain/errors.js';
import type { Result } from '../../domain/errors.js';
import type { Usage } from '../../domain/types.js';

export interface PriceInfo {
  inputPer1m: number;
  outputPer1m: number;
}

export type BudgetDeny =
  | { code: 'budget_exceeded'; message: string }
  | { code: 'price_unknown'; message: string };

/**
 * 预算守卫（基线 §6）：
 * - 调用前：按保守预估（输入字符折算 token + max_output_tokens 最坏情况）原子预留；
 *   已结算 + 在途预留 + 本次预估达到硬上限 → 拒绝。
 * - 调用后：有 usage 按实际结算；无 usage 按保守预估占用。
 * - 价格未知（未配置定价或币种非 USD）且设置了硬上限：默认 fail-closed 拒绝；
 *   显式 allow_unknown_price 才放行（此时不占预算，费用标为未知）。
 */
export class BudgetGuard {
  private spentUsd = 0;
  private reservedUsd = 0;

  constructor(
    private readonly limitUsd: number | undefined,
    private readonly allowUnknownPrice: boolean,
    private readonly priceOf: (providerId: string, modelId: string) => PriceInfo | undefined,
  ) {}

  get spent(): number {
    return this.spentUsd;
  }

  get reserved(): number {
    return this.reservedUsd;
  }

  /** 保守预估（USD）；价格未知返回 undefined */
  estimateCostUsd(promptChars: number, maxOutputTokens: number, providerId: string, modelId: string): number | undefined {
    const price = this.priceOf(providerId, modelId);
    if (!price) return undefined;
    const inputTokens = Math.ceil(promptChars / 4);
    return (inputTokens / 1e6) * price.inputPer1m + (maxOutputTokens / 1e6) * price.outputPer1m;
  }

  /** 调用前预留；返回预留金额（未知价格放行时为 0） */
  reserve(estimatedUsd: number | undefined, providerId: string, modelId: string): Result<number, BudgetDeny> {
    if (estimatedUsd === undefined) {
      if (this.limitUsd !== undefined && !this.allowUnknownPrice) {
        return err({
          code: 'price_unknown',
          message: `price for ${providerId}/${modelId} is unknown and a hard cost limit is set (fail-closed); add pricing or set allow_unknown_price: true`,
        });
      }
      return ok(0);
    }
    if (this.limitUsd !== undefined && this.spentUsd + this.reservedUsd + estimatedUsd >= this.limitUsd) {
      return err({
        code: 'budget_exceeded',
        message: `estimated cost ${estimatedUsd.toFixed(6)} USD would reach the hard limit ${this.limitUsd} USD (spent ${this.spentUsd.toFixed(6)}, reserved ${this.reservedUsd.toFixed(6)})`,
      });
    }
    this.reservedUsd += estimatedUsd;
    return ok(estimatedUsd);
  }

  /** 调用失败时释放预留，不计费用 */
  release(reservedUsd: number): void {
    this.reservedUsd = Math.max(0, this.reservedUsd - reservedUsd);
  }

  /** 调用后结算；返回实际成本（USD），价格未知返回 undefined */
  settle(
    reservedUsd: number,
    usage: Usage | undefined,
    providerId: string,
    modelId: string,
    promptChars: number,
    maxOutputTokens: number,
  ): number | undefined {
    this.release(reservedUsd);
    const price = this.priceOf(providerId, modelId);
    if (!price) return undefined;
    let actual: number;
    if (usage) {
      actual = (usage.inputTokens / 1e6) * price.inputPer1m + (usage.outputTokens / 1e6) * price.outputPer1m;
    } else {
      actual = reservedUsd > 0 ? reservedUsd : (this.estimateCostUsd(promptChars, maxOutputTokens, providerId, modelId) ?? 0);
    }
    this.spentUsd += actual;
    return actual;
  }
}
