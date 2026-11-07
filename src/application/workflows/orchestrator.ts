import { randomUUID } from 'node:crypto';
import { err, ok } from '../../domain/errors.js';
import type { Result } from '../../domain/errors.js';
import { redactText } from '../../logging/redact.js';
import type {
  AccessMode,
  CheckResult,
  ProviderErrorCode,
  RunRequest,
  RunResult,
  RunStatus,
  StepResult,
  StopReason,
  TriggerReason,
  Usage,
  UserOverrides,
} from '../../domain/types.js';
import { isStepEligible } from '../../domain/policies/state-machine.js';
import type { PriorOutcome } from '../../domain/policies/state-machine.js';
import { runDeterministicChecks } from '../../domain/evaluation/checks.js';
import { parseReview } from '../../domain/evaluation/review.js';
import { parseJudgeVerdict } from '../../domain/evaluation/judge.js';
import { answerAgreement } from '../../domain/evaluation/similarity.js';
import { renderStepPrompt, judgePrompt, aggregatorPrompt, debateOpeningPrompt, debateRebuttalPrompt, debateVerdictPrompt } from './templates.js';
import type { ReviewFeedback } from './templates.js';
import { BudgetGuard } from './budget.js';
import type { PriceInfo } from './budget.js';
import { createProvider } from '../../providers/registry.js';
import { CredentialStore } from '../../credentials/store.js';
import type { ProviderAdapter, ProviderChatResponse, ProviderError } from '../../providers/types.js';
import type { BayzeConfig, StepConfig, WorkflowConfig } from '../../config/schema.js';
import type { RunJournal } from '../../journal/journal.js';

export type RunSetupError =
  | { code: 'unknown_workflow'; message: string }
  | { code: 'input_too_large'; message: string }
  | { code: 'provider_unavailable'; message: string };

export interface StepProgress {
  step: string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
}

export interface RunOptions {
  signal: AbortSignal;
  onProgress?: (p: StepProgress) => void;
  journal?: RunJournal;
}

export const MAX_INPUT_CHARS = 100_000;
const RETRY_BACKOFF_BASE_MS = 100;
const RETRY_BACKOFF_CAP_MS = 10_000;


/** 引擎生成调用（裁决/聚合）的 token 上限从 evaluate.max_chars 推导（0.13.2）：
 *  中文 ≈1.4 字/token——物理上不允许模型写到必然被字符闸拒绝的长度，杜绝「整段丢弃白花钱」。 */
function tokenCapFor(evaluate: unknown[] | undefined, fallback: number): number {
  const mc = (evaluate ?? []).find((c) => typeof c === 'object' && c !== null && 'max_chars' in c) as { max_chars: number } | undefined;
  if (!mc) return fallback;
  // 除数取安全下界 1.0（0.14.1 修复）：实测中文密集输出仅 ~1.05 字/token——按更高比率
  // 设 token 上限会在字符闸触发前静默硬截断成品（半句交付，实测 114 tokens=119 字断句），
  // 比超闸被拒更糟。除数 1.0 使字符闸恒先触发，token 上限仅作成本兜底；残余超闸由压缩重试兜底。
  return Math.max(64, Math.min(fallback, Math.ceil(mc.max_chars / 1.0)));
}

/** 提取 evaluate 里的 max_chars 闸值（压缩重试用） */
function maxCharsOf(evaluate: unknown[] | undefined): number | undefined {
  const mc = (evaluate ?? []).find((c) => typeof c === 'object' && c !== null && 'max_chars' in c) as { max_chars: number } | undefined;
  return mc?.max_chars;
}

/**
 * 瀑布编排器（基线 §7 状态机的执行体）：
 * VALIDATE → 逐步执行（run_if 判定）→ 确定性检查 / 结构化评审门 → 升级或停止。
 * 重试与逻辑步骤分开计数；预算调用前预留、调用后结算；取消信号贯穿供应商调用。
 */
export class WorkflowOrchestrator {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly credentials = new CredentialStore();

  constructor(
    private readonly cfg: BayzeConfig,
    seedAdapters?: Map<string, ProviderAdapter>,
  ) {
    if (seedAdapters) {
      for (const [k, v] of seedAdapters) this.adapters.set(k, v);
    }
  }

  async run(req: RunRequest, opts: RunOptions): Promise<Result<RunResult, RunSetupError>> {
    const wf = this.cfg.workflows[req.workflowId];
    if (!wf) {
      return err({
        code: 'unknown_workflow',
        message: `unknown workflow "${req.workflowId}" (configured: ${Object.keys(this.cfg.workflows).join(', ') || 'none'})`,
      });
    }
    if (req.input.length > MAX_INPUT_CHARS) {
      return err({ code: 'input_too_large', message: `input is ${req.input.length} chars; hard limit is ${MAX_INPUT_CHARS}` });
    }
    // context 组装（0.13.1 修复：MCP 层此前接收 context 但编排器丢弃——用户的补充约束被静默扔掉）。
    // context 与 input 同为任务文本，进入模板的 ORIGINAL TASK（UNTRUSTED）块。
    const reqWithTask: RunRequest = req.context
      ? { ...req, input: `${req.input}\n\n=== CONTEXT (supplementary requirements / background) ===\n${req.context}` }
      : req;
    const taskInput = reqWithTask.input;
    for (const step of wf.steps) {
      if (this.adapters.has(step.provider)) continue;
      const pcfg = this.cfg.providers[step.provider];
      if (!pcfg) {
        return err({ code: 'provider_unavailable', message: `step "${step.name}" references provider "${step.provider}" missing from config` });
      }
      const created = createProvider(step.provider, pcfg, this.credentials);
      if (!created.ok) return err({ code: 'provider_unavailable', message: created.error.message });
      this.adapters.set(step.provider, created.value);
    }

    // P2-④ 人工批准：预估总费用超过门槛且用户未确认 → 暂停（对全部策略生效，先于策略分发——
    // 0.12.0 修复：此前审批检查位于 parallel 分发之后，parallel/moa 会绕过批准）
    if (wf.limits.approval_threshold_usd !== undefined && req.userOverrides?.approved !== true) {
      const estTotal = this.estimateWorkflowCost(wf, taskInput);
      if (estTotal !== undefined && estTotal >= wf.limits.approval_threshold_usd) {
        return {
          ok: true,
          value: {
            runId: randomUUID(),
            status: 'skipped' as RunStatus,
            steps: [],
            stopReason: 'pending_approval' as StopReason,
            triggerReason: undefined,
            warnings: [
              `Estimated cost $${estTotal.toFixed(4)} exceeds approval threshold $${wf.limits.approval_threshold_usd}.`,
              `Re-run with user_overrides.approved=true to proceed.`,
            ],
          },
        };
      }
    }

    // parallel / moa 策略：多模型同时执行同一任务（P1 / ADR-0005 D1、ADR-0006 D6）
    if (wf.strategy === 'parallel' || wf.strategy === 'moa') {
      return this.runParallel(wf, reqWithTask, opts);
    }

    // debate 策略（ADR-0006 D7）：双方独立开场 → K 轮同时反驳 → 裁决者综观全程出最终答案
    if (wf.strategy === 'debate') {
      return this.runDebate(wf, reqWithTask, opts);
    }

    const warnings: string[] = [];
    const { maxSteps, totalTimeoutMs, maxCostUsd, maxChars } = applyOverrides(wf, req.userOverrides, warnings);
    /** P1/ADR-0003 D4：per-run max_chars 覆盖——收紧-only，注入确定性检查 */
    const effectiveChecks = (step: (typeof wf.steps)[number]) => {
      if (maxChars === undefined) return step.evaluate;
      return step.evaluate.map((c) =>
        typeof c === 'object' && 'max_chars' in c ? { max_chars: Math.min(c.max_chars, maxChars) } : c,
      );
    };

    const runId = randomUUID();
    const startedMs = Date.now();
    const deadline = startedMs + totalTimeoutMs;
    const guard = new BudgetGuard(maxCostUsd, wf.limits.allow_unknown_price, makePriceBook(this.cfg));

    const stepResults: StepResult[] = [];
    const recorded = new Set<number>();
    let prior: PriorOutcome | undefined;
    let finalOutput: string | undefined;
    let lastSuccessOutput: string | undefined;
    let reviewSummary: ReviewFeedback | undefined;
    let triggerReason: TriggerReason | undefined;
    let stopReason: StopReason | undefined;
    let step0CheckFailure = false;
    let executed = 0;
    let capSkipped = 0;
    let usedBayzeApi = false;
    let reviseDelivered = false;
    /** 修订循环状态（ADR-0006 D3/D5） */
    const maxRevisions = wf.limits.max_revisions;
    let revisionsDone = 0;
    let gateIdx: number | undefined;
    let startIdx = 0;

    const modeOf = (providerId: string): AccessMode => {
      const p = this.cfg.providers[providerId];
      return p && p.kind !== 'mock' ? p.mode : 'byok';
    };

    // 外层修订循环（ADR-0006 D3）：单轮线性执行完毕后，若评审仍打回且修订已交付且次数未用尽 → 跳回评审步
    while (true) {
    for (let idx = startIdx; idx < wf.steps.length; idx++) {
      const step = wf.steps[idx];
      if (!step) break;
      if (opts.signal.aborted) {
        stopReason = 'cancelled';
        break;
      }
      if (Date.now() >= deadline) {
        stopReason = 'timed_out';
        break;
      }
      if (executed >= maxSteps) {
        stepResults.push(skippedResult(idx, step));
        recorded.add(idx);
        capSkipped++;
        continue;
      }
      if (idx > 0 && (step.run_if === undefined || !isStepEligible(step.run_if, prior, false))) {
        stepResults.push(skippedResult(idx, step));
        recorded.add(idx);
        opts.onProgress?.({ step: step.name, status: 'skipped' });
        continue;
      }

      const prompt = renderStepPrompt(step.input, {
        original: taskInput,
        previousOutput: lastSuccessOutput,
        reviewFeedback: reviewSummary,
        reviewSchemaFields: step.review_schema ?? ['verdict', 'reasons'],
        rubric: step.rubric,
      });
      if (!prompt.ok) {
        stepResults.push(stepResult(idx, step, 'failed', Date.now()));
        recorded.add(idx);
        warnings.push(prompt.error.message);
        stopReason = 'missing_required_input';
        break;
      }

      executed++;
      const stepMode = modeOf(step.provider);
      if (stepMode === 'bayze_api') usedBayzeApi = true;
      opts.onProgress?.({ step: step.name, status: 'running' });
      const stepStart = Date.now();
      const promptChars = (prompt.value.system ?? '').length + prompt.value.user.length;
      const estimate = guard.estimateCostUsd(promptChars, wf.limits.max_output_tokens, step.provider, step.model);
      const reservation = guard.reserve(estimate, step.provider, step.model);
      if (!reservation.ok) {
        stepResults.push(stepResult(idx, step, 'budget_exceeded', stepStart));
        recorded.add(idx);
        warnings.push(reservation.error.message);
        stopReason = 'budget_exceeded';
        opts.onProgress?.({ step: step.name, status: 'failed' });
        break;
      }

      const retries = step.max_retries ?? wf.limits.max_retries_per_step;
      const timeoutMs = Math.max(1, Math.min(step.timeout_ms, deadline - Date.now()));
      const call = await this.callWithRetry(step, prompt.value, {
        timeoutMs,
        retries,
        signal: opts.signal,
        maxOutputTokens: wf.limits.max_output_tokens,
      });

      if (!call.ok) {
        const e = call.error;
        guard.release(reservation.value);
        stepResults.push(stepResult(idx, step, 'failed', stepStart, { errorCode: e.code }));
        recorded.add(idx);
        opts.onProgress?.({ step: step.name, status: 'failed' });
        warnings.push(redactText(`step "${step.name}" provider error (${e.code}, attempts ${e.attempts}): ${e.message}`));
        if (opts.signal.aborted) {
          stopReason = 'cancelled';
          break;
        }
        if (step.gate === 'structured_review') {
          // 基线 §7：reviewer 超时/被拒 → 停止，不默认 accept，不升级
          warnings.push(`review step "${step.name}" failed (${e.code}); failing closed — the draft is NOT accepted`);
          stopReason = 'review_failed';
          break;
        }
        prior = { kind: 'provider_error', code: e.code };
        triggerReason = e.code === 'timeout' ? 'provider_timeout' : e.code === 'rate_limit' ? 'rate_limit' : `provider_error:${e.code}`;
        if (e.code === 'auth') {
          // 基线 §7：密钥错误停止，不升级
          warnings.push('auth error: stopping without escalation; check the provider API key environment variable');
          stopReason = 'workflow_exhausted';
          break;
        }
        continue;
      }

      const usage = call.value.usage;
      const cost = guard.settle(reservation.value, usage, step.provider, step.model, promptChars, wf.limits.max_output_tokens);
      if (cost === undefined) {
        warnings.push(`cost for ${step.provider}/${step.model} could not be estimated (unknown price or missing usage)`);
      } else if (usage === undefined) {
        warnings.push(`provider returned no usage for step "${step.name}"; cost settled conservatively from the estimate`);
      }

      if (step.gate === 'structured_review') {
        const parsed = parseReview(call.value.content, step.review_schema ?? ['verdict']);
        if (!parsed.ok) {
          stepResults.push(
            stepResult(idx, step, 'failed', stepStart, {
              usage,
              estimatedCost: cost,
              checks: [{ checkId: 'structured_review', passed: false, detail: parsed.error.message }],
            }),
          );
          recorded.add(idx);
          warnings.push(`reviewer output rejected (${parsed.error.code}); failing closed — the draft is NOT accepted`);
          stopReason = 'review_failed';
          opts.onProgress?.({ step: step.name, status: 'failed' });
          break;
        }
        reviewSummary = parsed.value;
        prior = { kind: 'review_verdict', verdict: parsed.value.verdict };
        gateIdx = idx;
        stepResults.push(
          stepResult(idx, step, 'succeeded', stepStart, {
            usage,
            estimatedCost: cost,
            checks: [{ checkId: 'structured_review', passed: true, detail: `verdict=${parsed.value.verdict}` }],
          }),
        );
        recorded.add(idx);
        opts.onProgress?.({ step: step.name, status: 'succeeded' });
        continue;
      }

      const checks = runDeterministicChecks(call.value.content, effectiveChecks(step));
      if (checks.every((c) => c.passed)) {
        lastSuccessOutput = call.value.content;
        finalOutput = call.value.content;
        prior = { kind: 'success' };
        if (reviewSummary?.verdict === 'revise') {
          reviseDelivered = true;
          revisionsDone++;
        }
        stepResults.push(stepResult(idx, step, 'succeeded', stepStart, { usage, estimatedCost: cost, checks }));
        recorded.add(idx);
        opts.onProgress?.({ step: step.name, status: 'succeeded' });
      } else {
        if (idx === 0) step0CheckFailure = true;
        const firstFailed = checks.find((c) => !c.passed);
        triggerReason = `check_failed:${firstFailed?.checkId ?? 'unknown'}`;
        prior = { kind: 'check_failure' };
        stepResults.push(stepResult(idx, step, 'failed', stepStart, { usage, estimatedCost: cost, checks }));
        recorded.add(idx);
        opts.onProgress?.({ step: step.name, status: 'failed' });
      }
    } // end inner for

    // 修订循环判定（ADR-0006 D3）：评审仍打回 + 修订已交付 + 次数未用尽 + 预算/时间允许 → 跳回评审步
    const loopMore =
      stopReason === undefined &&
      gateIdx !== undefined &&
      reviewSummary?.verdict === 'revise' &&
      reviseDelivered &&
      revisionsDone < maxRevisions &&
      executed + 2 <= maxSteps &&
      Date.now() < deadline &&
      !opts.signal.aborted;
    if (!loopMore || gateIdx === undefined) break;
    reviseDelivered = false;
    startIdx = gateIdx;
    warnings.push(`revision loop: revision ${revisionsDone} delivered but reviewer still requests changes — re-reviewing (revisions used ${revisionsDone}/${maxRevisions})`);
    } // end outer revision loop

    if (stopReason === undefined && reviewSummary?.verdict === 'revise' && reviseDelivered && maxRevisions > 1 && revisionsDone >= maxRevisions) {
      warnings.push(`max_revisions=${maxRevisions} reached; delivering the latest revision although the reviewer still requests changes`);
    }

    // 升级最后一次修订（ADR-0006 D5）：循环用尽仍 revise 且配置了 escalate_to → 换强模型再修一次（不再重评审）
    if (
      stopReason === undefined &&
      wf.escalate_to &&
      reviewSummary?.verdict === 'revise' &&
      reviseDelivered &&
      lastSuccessOutput !== undefined &&
      revisionsDone >= maxRevisions &&
      executed < maxSteps &&
      Date.now() < deadline &&
      !opts.signal.aborted
    ) {
      const esc = wf.escalate_to;
      if (!this.adapters.has(esc.provider)) {
        const pcfg = this.cfg.providers[esc.provider];
        if (pcfg) {
          const created = createProvider(esc.provider, pcfg, this.credentials);
          if (created.ok) this.adapters.set(esc.provider, created.value);
        }
      }
      if (!this.adapters.has(esc.provider)) {
        warnings.push(`escalation skipped: provider "${esc.provider}" unavailable`);
      } else {
        const prompt = renderStepPrompt('revision_template', {
          original: taskInput,
          previousOutput: lastSuccessOutput,
          reviewFeedback: reviewSummary,
          reviewSchemaFields: ['verdict', 'reasons'],
        });
        if (prompt.ok) {
          executed++;
          const stepStart = Date.now();
          const promptChars = (prompt.value.system ?? '').length + prompt.value.user.length;
          const estimate = guard.estimateCostUsd(promptChars, wf.limits.max_output_tokens, esc.provider, esc.model);
          const reservation = guard.reserve(estimate, esc.provider, esc.model);
          if (!reservation.ok) {
            warnings.push(`escalation skipped: ${reservation.error.message}`);
          } else {
            const synthetic = { name: 'escalate', provider: esc.provider, model: esc.model } as StepConfig;
            const timeoutMs = Math.max(1, Math.min(esc.timeout_ms ?? 60_000, deadline - Date.now()));
            const call = await this.callWithRetry(synthetic, prompt.value, {
              timeoutMs,
              retries: wf.limits.max_retries_per_step,
              signal: opts.signal,
              maxOutputTokens: wf.limits.max_output_tokens,
            });
            if (!call.ok) {
              guard.release(reservation.value);
              warnings.push(redactText(`escalated revision failed (${call.error.code}); keeping the previous revision`));
              stepResults.push({
                stepId: `${stepResults.length + 1}.escalate`, stepName: 'escalate',
                providerId: esc.provider, modelId: esc.model, status: 'failed',
                startedAt: new Date(stepStart).toISOString(), durationMs: Date.now() - stepStart,
                checks: [], errorCode: call.error.code,
              });
            } else {
              const cost = guard.settle(reservation.value, call.value.usage, esc.provider, esc.model, promptChars, wf.limits.max_output_tokens);
              // 成品确定性检查（0.12.2）：escalate_to.evaluate（缺省 non_empty）+ per-run maxChars 收紧
              const escBase = esc.evaluate ?? ['non_empty' as const];
              const escChecksSpec = maxChars === undefined
                ? escBase
                : escBase.map((c) => (typeof c === 'object' && 'max_chars' in c ? { max_chars: Math.min(c.max_chars, maxChars) } : c));
              const escChecks = runDeterministicChecks(call.value.content, escChecksSpec);
              const escPassed = escChecks.every((c) => c.passed);
              if (escPassed) {
                lastSuccessOutput = call.value.content;
                finalOutput = call.value.content;
              } else {
                warnings.push('escalated revision rejected by deterministic checks; keeping the previous revision');
              }
              stepResults.push({
                stepId: `${stepResults.length + 1}.escalate`, stepName: 'escalate',
                providerId: esc.provider, modelId: esc.model, status: escPassed ? 'succeeded' : 'failed',
                startedAt: new Date(stepStart).toISOString(), durationMs: Date.now() - stepStart,
                checks: escChecks, usage: call.value.usage, ...(cost !== undefined ? { estimatedCost: cost } : {}),
              });
              if (escPassed) {
                warnings.push(`escalated final revision to ${esc.provider}/${esc.model} after ${revisionsDone} revision(s) still failed review`);
              }
              opts.onProgress?.({ step: 'escalate', status: escPassed ? 'succeeded' : 'failed' });
            }
          }
        }
      }
    }
    for (let idx = 0; idx < wf.steps.length; idx++) {
      if (!recorded.has(idx)) {
        const step = wf.steps[idx];
        if (step) stepResults.push(skippedResult(idx, step));
      }
    }
    if (capSkipped > 0) {
      warnings.push(`maxSteps=${maxSteps} truncated ${capSkipped} configured step(s)`);
    }
    if (usedBayzeApi) {
      warnings.push('Bayze API 模式：本地费用仅为估算，实际扣费以平台账单为准（充值/账单：https://app.lanwealth.com/dashboard/billing）');
    }

    // 每步展示接入模式（基线 v0.4.1 §5/§6）
    for (const sr of stepResults) {
      sr.mode = modeOf(sr.providerId);
    }

    if (stopReason === undefined) {
      if (opts.signal.aborted) stopReason = 'cancelled';
      else if (finalOutput === undefined && Date.now() >= deadline) stopReason = 'timed_out';
      else if (finalOutput === undefined && step0CheckFailure) stopReason = 'draft_check_failed';
      else if (finalOutput === undefined) stopReason = 'workflow_exhausted';
      else if (reviewSummary?.verdict === 'revise' && !reviseDelivered) {
        // dogfood 发现：评审打回但修订步失败时，不能报 succeeded——用户拿到的是已知需修订的草稿
        stopReason = 'workflow_exhausted';
        warnings.push('reviewer requested revision but the revise step did not deliver; returning the un-revised draft with failed status');
      }
      else stopReason = 'completed';
    }

    const status: RunStatus = runStatusFor(stopReason);

    const result: RunResult = { runId, status, finalOutput, steps: stepResults, stopReason, triggerReason, warnings, reviewSummary };

    if (opts.journal?.enabled) {
      const jr = opts.journal.append({
        v: 1,
        ts: new Date().toISOString(),
        runId,
        workflowId: req.workflowId,
        status,
        stopReason,
        triggerReason,
        durationMs: Date.now() - startedMs,
        steps: stepResults.map((s) => ({
          name: s.stepName,
          providerId: s.providerId,
          modelId: s.modelId,
          mode: s.mode,
          status: s.status,
          durationMs: s.durationMs,
          usage: s.usage,
          estimatedCost: s.estimatedCost,
        })),
        warnings,
      });
      if (!jr.ok) warnings.push(jr.error);
    }
    return { ok: true, value: result };
  }

  /**
   * parallel 策略（P1）：所有步骤同时执行同一输入，返回全部结果供对比。
   * 无 run_if / gate / 升级——纯比较模式。
   */
  private async runParallel(
    wf: WorkflowConfig,
    req: RunRequest,
    opts: RunOptions,
  ): Promise<Result<RunResult, RunSetupError>> {
    const warnings: string[] = [];
    const runId = randomUUID();
    const startedMs = Date.now();
    const deadline = startedMs + wf.limits.total_timeout_ms;
    const guard = new BudgetGuard(wf.limits.max_cost_usd, wf.limits.allow_unknown_price, makePriceBook(this.cfg));
    const stepResults: StepResult[] = [];
    const outputs: Array<{ name: string; model: string; content: string }> = [];

    const modeOf = (providerId: string): AccessMode => {
      const p = this.cfg.providers[providerId];
      return p && p.kind !== 'mock' ? p.mode : 'byok';
    };

    /** per-run max_chars 收紧覆盖（ADR-0003 D4）——parallel/moa 同样生效（0.12.1 修复：此前仅 waterfall 应用） */
    const { maxChars } = applyOverrides(wf, req.userOverrides, warnings);
    const effectiveChecks = (step: (typeof wf.steps)[number]) => {
      if (maxChars === undefined) return step.evaluate;
      return step.evaluate.map((c) =>
        typeof c === 'object' && 'max_chars' in c ? { max_chars: Math.min(c.max_chars, maxChars) } : c,
      );
    };

    // 并发执行所有步骤
    const promises = wf.steps.map(async (step, idx) => {
      const stepStart = Date.now();
      const mode = modeOf(step.provider);
      const stepMode = mode;
      const prompt = renderStepPrompt('original', {
        original: req.input,
        reviewSchemaFields: ['verdict', 'reasons'],
      });
      if (!prompt.ok) {
        return { idx, step, status: 'failed' as RunStatus, errorCode: undefined as ProviderErrorCode | undefined, checks: [], usage: undefined, cost: undefined, content: '', durationMs: 0 };
      }

      const promptChars = prompt.value.user.length;
      const estimate = guard.estimateCostUsd(promptChars, wf.limits.max_output_tokens, step.provider, step.model);
      const reservation = guard.reserve(estimate, step.provider, step.model);
      if (!reservation.ok) {
        return { idx, step, status: 'budget_exceeded' as RunStatus, errorCode: undefined, checks: [], usage: undefined, cost: undefined, content: '', durationMs: 0 };
      }

      const timeoutMs = Math.max(1, Math.min(step.timeout_ms, deadline - Date.now()));
      const call = await this.callWithRetry(step, prompt.value, {
        timeoutMs,
        retries: step.max_retries ?? wf.limits.max_retries_per_step,
        signal: opts.signal,
        maxOutputTokens: wf.limits.max_output_tokens,
      });

      if (!call.ok) {
        guard.release(reservation.value);
        return { idx, step, status: 'failed' as RunStatus, errorCode: call.error.code, checks: [], usage: undefined, cost: undefined, content: '', durationMs: Date.now() - stepStart };
      }

      const cost = guard.settle(reservation.value, call.value.usage, step.provider, step.model, promptChars, wf.limits.max_output_tokens);
      const checks = runDeterministicChecks(call.value.content, effectiveChecks(step));
      const allPassed = checks.every((c) => c.passed);
      return {
        idx, step, status: (allPassed ? 'succeeded' : 'failed') as RunStatus,
        errorCode: undefined, checks, usage: call.value.usage, cost,
        content: call.value.content, durationMs: Date.now() - stepStart,
      };
    });

    const settled = await Promise.allSettled(promises);

    // 按原始顺序整理结果
    for (let idx = 0; idx < wf.steps.length; idx++) {
      const step = wf.steps[idx];
      if (!step) continue;
      const result = settled.find((s) => s.status === 'fulfilled' && s.value.idx === idx);
      if (result && result.status === 'fulfilled') {
        const v = result.value;
        const mode = modeOf(step.provider);
        const sr: StepResult = {
          stepId: `${idx + 1}.${step.name}`,
          stepName: step.name,
          providerId: step.provider,
          modelId: step.model,
          mode,
          status: v.status,
          startedAt: new Date(startedMs).toISOString(),
          durationMs: v.durationMs,
          checks: v.checks,
        };
        if (v.usage) sr.usage = v.usage;
        if (v.cost !== undefined) sr.estimatedCost = v.cost;
        if (v.errorCode) sr.errorCode = v.errorCode;
        stepResults.push(sr);
        if (v.status === 'succeeded' && v.content) {
          outputs.push({ name: step.name, model: step.model, content: v.content });
        }
      } else {
        stepResults.push({
          stepId: `${idx + 1}.${step.name}`,
          stepName: step.name,
          providerId: step.provider,
          modelId: step.model,
          mode: modeOf(step.provider),
          status: 'failed' as RunStatus,
          startedAt: new Date(startedMs).toISOString(),
          durationMs: 0,
          checks: [],
        });
      }
    }

    // 默认 finalOutput = 所有成功输出的拼接对比（评委选优成功时被覆盖）
    let finalOutput: string | undefined = outputs.length > 0
      ? outputs.map((o) => `[${o.name}/${o.model}]\n${o.content}`).join('\n\n---\n\n')
      : undefined;

    // 输出一致性（ADR-0006 D2）：成功候选间的确定性一致性信号，零额外调用
    const agreement = answerAgreement(outputs.map((o) => o.content));

    // 评委自动选优（ADR-0006 D1）：≥2 成功输出且配置了 judge；失败降级为拼接对比
    let judgeSummary: RunResult['judgeSummary'];
    let candidates: RunResult['candidates'];
    if (wf.judge && outputs.length >= 2) {
      const judged = await this.runJudge(wf, req.input, outputs, {
        guard,
        deadline,
        signal: opts.signal,
        maxOutputTokens: wf.limits.max_output_tokens,
        maxRetries: wf.limits.max_retries_per_step,
      });
      if (judged.ok) {
        judgeSummary = judged.value.summary;
        finalOutput = judged.value.winnerContent;
        stepResults.push(judged.value.step);
        candidates = outputs.map((o) => ({ stepName: o.name, modelId: o.model, content: o.content }));
        warnings.push(`judge selected "${judged.value.summary.winnerStep}": ${judged.value.summary.reason.slice(0, 160)}`);
      } else {
        warnings.push(judged.error.warning);
        if (judged.error.step) stepResults.push(judged.error.step);
      }
    } else if (wf.judge) {
      warnings.push(`judge skipped: need >= 2 successful outputs (got ${outputs.length})`);
    }

    // MoA 聚合（ADR-0006 D6）：strategy: moa 必配 aggregate；N 份候选合成一份；失败降级拼接对比
    if (wf.strategy === 'moa' && wf.aggregate && outputs.length >= 1) {
      // 候选全文始终结构化返回（0.12.5：此前仅 judge 路径附 candidates——Cherry 终验发现
      // moa 路径漏配，降级时原文只在拼接里、成功时完全不可见，审计面不完整）
      candidates = outputs.map((o) => ({ stepName: o.name, modelId: o.model, content: o.content }));
      const agg = await this.runAggregator(wf, req.input, outputs, {
        guard,
        deadline,
        signal: opts.signal,
        maxOutputTokens: wf.limits.max_output_tokens,
        maxRetries: wf.limits.max_retries_per_step,
        maxChars,
      });
      if (agg.ok) {
        finalOutput = agg.value.content;
        stepResults.push(agg.value.step, ...(agg.value.extraSteps ?? []));
        warnings.push(`moa: aggregated ${outputs.length} candidate(s) into the final answer`);
        if (agg.value.truncated) {
          warnings.push('aggregate output may be truncated by the token cap (does not end with terminal punctuation) — treat the tail as incomplete');
        }
      } else {
        warnings.push(agg.error.warning);
        if (agg.error.step) stepResults.push(agg.error.step);
      }
    }

    const succeededCount = outputs.length;
    const status: RunStatus = succeededCount > 0 ? 'succeeded' : 'failed';
    const stopReason: StopReason = succeededCount > 0 ? 'completed' : 'workflow_exhausted';
    warnings.push(`parallel: ${succeededCount}/${wf.steps.length} models succeeded`);

    if (guard.reserved > 0) warnings.push(`unreleased budget reservation: $${guard.reserved.toFixed(6)}`);

    const result: RunResult = {
      runId, status, finalOutput, steps: stepResults, stopReason, warnings,
      ...(agreement !== undefined ? { agreement } : {}),
      ...(judgeSummary !== undefined ? { judgeSummary } : {}),
      ...(candidates !== undefined ? { candidates } : {}),
    };

    if (opts.journal?.enabled) {
      const jr = opts.journal.append({
        v: 1, ts: new Date().toISOString(), runId, workflowId: req.workflowId,
        status, stopReason, durationMs: Date.now() - startedMs,
        steps: stepResults.map((s) => ({ name: s.stepName, providerId: s.providerId, modelId: s.modelId, mode: s.mode, status: s.status, durationMs: s.durationMs, usage: s.usage, estimatedCost: s.estimatedCost })),
        warnings,
      });
      if (!jr.ok) warnings.push(jr.error);
    }
    return { ok: true, value: result };
  }

  /**
   * 评委调用（ADR-0006 D1）：完整预算流程 + 独立 StepResult；
   * 任何失败都以 err 返回（warning + 可选失败步骤记录），由调用方降级。
   */
  private async runJudge(
    wf: WorkflowConfig,
    original: string,
    outputs: Array<{ name: string; model: string; content: string }>,
    o: { guard: BudgetGuard; deadline: number; signal: AbortSignal; maxOutputTokens: number; maxRetries: number },
  ): Promise<Result<
    { summary: NonNullable<RunResult['judgeSummary']>; step: StepResult; winnerContent: string },
    { warning: string; step?: StepResult }
  >> {
    const judge = wf.judge;
    if (!judge) return err({ warning: 'judge not configured' });
    if (!this.adapters.has(judge.provider)) {
      const pcfg = this.cfg.providers[judge.provider];
      if (!pcfg) return err({ warning: `judge provider "${judge.provider}" missing from config; falling back to concatenated comparison` });
      const created = createProvider(judge.provider, pcfg, this.credentials);
      if (!created.ok) return err({ warning: `judge adapter unavailable: ${created.error.message}` });
      this.adapters.set(judge.provider, created.value);
    }
    const mode = (() => {
      const p = this.cfg.providers[judge.provider];
      return p && p.kind !== 'mock' ? p.mode : ('byok' as AccessMode);
    })();

    const prompt = judgePrompt({ original, candidates: outputs });
    const promptChars = (prompt.system ?? '').length + prompt.user.length;
    const estimate = o.guard.estimateCostUsd(promptChars, o.maxOutputTokens, judge.provider, judge.model);
    const reservation = o.guard.reserve(estimate, judge.provider, judge.model);
    if (!reservation.ok) return err({ warning: `judge skipped: ${reservation.error.message}` });

    const synthetic = { name: 'judge', provider: judge.provider, model: judge.model } as StepConfig;
    const stepStart = Date.now();
    const timeoutMs = Math.max(1, Math.min(judge.timeout_ms ?? 60_000, o.deadline - Date.now()));
    const call = await this.callWithRetry(synthetic, prompt, {
      timeoutMs,
      retries: o.maxRetries,
      signal: o.signal,
      maxOutputTokens: o.maxOutputTokens,
    });
    const failedStep = (detail: string, errorCode?: ProviderErrorCode): StepResult => ({
      stepId: 'judge',
      stepName: 'judge',
      providerId: judge.provider,
      modelId: judge.model,
      mode,
      status: 'failed',
      startedAt: new Date(stepStart).toISOString(),
      durationMs: Date.now() - stepStart,
      checks: [{ checkId: 'judge_selection', passed: false, detail }],
      ...(errorCode !== undefined ? { errorCode } : {}),
    });
    if (!call.ok) {
      o.guard.release(reservation.value);
      return err({ warning: `judge call failed (${call.error.code}); falling back to concatenated comparison`, step: failedStep(`call failed: ${call.error.code}`, call.error.code) });
    }
    const cost = o.guard.settle(reservation.value, call.value.usage, judge.provider, judge.model, promptChars, o.maxOutputTokens);
    const parsed = parseJudgeVerdict(call.value.content, outputs.map((x) => x.name));
    if (!parsed.ok) {
      return err({ warning: `judge output rejected (${parsed.error.code}); falling back to concatenated comparison`, step: failedStep(parsed.error.message) });
    }
    const winner = outputs.find((x) => x.name === parsed.value.winner)!;
    const step: StepResult = {
      stepId: 'judge',
      stepName: 'judge',
      providerId: judge.provider,
      modelId: judge.model,
      mode,
      status: 'succeeded',
      startedAt: new Date(stepStart).toISOString(),
      durationMs: Date.now() - stepStart,
      checks: [{ checkId: 'judge_selection', passed: true, detail: `winner=${winner.name}` }],
      usage: call.value.usage,
      ...(cost !== undefined ? { estimatedCost: cost } : {}),
    };
    return ok({
      summary: { winnerStep: winner.name, providerId: judge.provider, modelId: judge.model, reason: parsed.value.reason },
      step,
      winnerContent: winner.content,
    });
  }

  /**
   * debate 策略（ADR-0006 D7）：开场×2（并行）→ rounds×2 同时反驳 → 裁决者出最终答案。
   * 每次调用走完整预算流程并独立 StepResult；裁决失败降级为辩论记录拼接（增强不闸门）。
   */
  private async runDebate(
    wf: WorkflowConfig,
    req: RunRequest,
    opts: RunOptions,
  ): Promise<Result<RunResult, RunSetupError>> {
    const warnings: string[] = [];
    const runId = randomUUID();
    const startedMs = Date.now();
    const deadline = startedMs + wf.limits.total_timeout_ms;
    const guard = new BudgetGuard(wf.limits.max_cost_usd, wf.limits.allow_unknown_price, makePriceBook(this.cfg));
    const stepResults: StepResult[] = [];
    const rounds = wf.rounds;

    const modeOf = (providerId: string): AccessMode => {
      const p = this.cfg.providers[providerId];
      return p && p.kind !== 'mock' ? p.mode : 'byok';
    };

    /** 单次辩手发言（开场/反驳共用）：预算 reserve→call→settle→checks */
    const speak = async (
      step: StepConfig,
      prompt: { system?: string; user: string },
      label: string,
    ): Promise<{ ok: boolean; content: string }> => {
      const stepStart = Date.now();
      const promptChars = (prompt.system ?? '').length + prompt.user.length;
      const estimate = guard.estimateCostUsd(promptChars, wf.limits.max_output_tokens, step.provider, step.model);
      const reservation = guard.reserve(estimate, step.provider, step.model);
      if (!reservation.ok) {
        stepResults.push({
          stepId: label, stepName: `${step.name}`, providerId: step.provider, modelId: step.model,
          mode: modeOf(step.provider), status: 'budget_exceeded', startedAt: new Date(stepStart).toISOString(),
          durationMs: 0, checks: [],
        });
        warnings.push(reservation.error.message);
        return { ok: false, content: '' };
      }
      const timeoutMs = Math.max(1, Math.min(step.timeout_ms, deadline - Date.now()));
      const call = await this.callWithRetry(step, prompt, {
        timeoutMs,
        retries: step.max_retries ?? wf.limits.max_retries_per_step,
        signal: opts.signal,
        maxOutputTokens: wf.limits.max_output_tokens,
      });
      const sr: StepResult = {
        stepId: label, stepName: step.name, providerId: step.provider, modelId: step.model,
        mode: modeOf(step.provider), status: 'succeeded', startedAt: new Date(stepStart).toISOString(),
        durationMs: Date.now() - stepStart, checks: [],
      };
      if (!call.ok) {
        guard.release(reservation.value);
        sr.status = 'failed';
        sr.errorCode = call.error.code;
        warnings.push(redactText(`debate step "${label}" failed (${call.error.code}): ${call.error.message.slice(0, 120)}`));
        stepResults.push(sr);
        return { ok: false, content: '' };
      }
      const cost = guard.settle(reservation.value, call.value.usage, step.provider, step.model, promptChars, wf.limits.max_output_tokens);
      const checks = runDeterministicChecks(call.value.content, step.evaluate);
      const allPassed = checks.every((c) => c.passed);
      sr.checks = checks;
      sr.status = allPassed ? 'succeeded' : 'failed';
      if (call.value.usage) sr.usage = call.value.usage;
      if (cost !== undefined) sr.estimatedCost = cost;
      stepResults.push(sr);
      return { ok: allPassed, content: call.value.content };
    };

    // 适配器就绪（双方 + 裁决者）
    for (const target of [wf.steps[0]!, wf.steps[1]!, wf.judge!]) {
      if (this.adapters.has(target.provider)) continue;
      const pcfg = this.cfg.providers[target.provider];
      if (!pcfg) return err({ code: 'provider_unavailable', message: `debate references provider "${target.provider}" missing from config` });
      const created = createProvider(target.provider, pcfg, this.credentials);
      if (!created.ok) return err({ code: 'provider_unavailable', message: created.error.message });
      this.adapters.set(target.provider, created.value);
    }

    const a = wf.steps[0]!;
    const b = wf.steps[1]!;
    const exchanges: Array<{ name: string; model: string; round: string; content: string }> = [];

    // ① 开场：双方独立作答（并行；不预设立场，分歧自然涌现）
    const openings = await Promise.all([
      speak(a, debateOpeningPrompt(req.input, wf.stances?.[0]), '1.opening'),
      speak(b, debateOpeningPrompt(req.input, wf.stances?.[1]), '2.opening'),
    ]);
    let posA = openings[0]?.ok ? openings[0].content : '';
    let posB = openings[1]?.ok ? openings[1].content : '';
    if (posA) exchanges.push({ name: a.name, model: a.model, round: 'opening', content: posA });
    if (posB) exchanges.push({ name: b.name, model: b.model, round: 'opening', content: posB });

    // ② 反驳轮：双方同时看到对方上一轮立场（同时制=公平，Du et al. 2023）
    for (let r = 1; r <= rounds; r++) {
      if (!posA || !posB) {
        warnings.push(`debate round ${r} skipped: a side failed to hold a position`);
        break;
      }
      if (Date.now() >= deadline || opts.signal.aborted) break;
      const promptA = debateRebuttalPrompt({ original: req.input, own: posA, opponent: posB, round: r, stance: wf.stances?.[0] });
      const promptB = debateRebuttalPrompt({ original: req.input, own: posB, opponent: posA, round: r, stance: wf.stances?.[1] });
      const res = await Promise.all([
        posA ? speak(a, promptA, `${2 * r + 1}.${a.name}-r${r}`) : Promise.resolve({ ok: false, content: '' }),
        posB ? speak(b, promptB, `${2 * r + 2}.${b.name}-r${r}`) : Promise.resolve({ ok: false, content: '' }),
      ]);
      const newA = res[0]?.ok ? res[0].content : posA;
      const newB = res[1]?.ok ? res[1].content : posB;
      if (res[0]?.ok) exchanges.push({ name: a.name, model: a.model, round: `round ${r}`, content: newA });
      if (res[1]?.ok) exchanges.push({ name: b.name, model: b.model, round: `round ${r}`, content: newB });
      posA = newA;
      posB = newB;
    }

    // ③ 裁决：综观全程，输出最终答案（自由文本 + judge.evaluate 确定性检查）
    // 0.13.1：零立场时直接失败收场——无辩可裁，不再空跑裁决（此前会对空 exchanges 裁决并白花一次调用）
    const arbiter = wf.judge!;
    if (exchanges.length === 0) {
      warnings.push('debate: no debater held a position (openings failed their deterministic checks); nothing to arbitrate');
      const emptyResult: RunResult = {
        runId, status: 'failed', finalOutput: undefined, steps: stepResults, stopReason: 'workflow_exhausted', warnings,
      };
      if (opts.journal?.enabled) {
        const jr = opts.journal.append({
          v: 1, ts: new Date().toISOString(), runId, workflowId: req.workflowId,
          status: 'failed', stopReason: 'workflow_exhausted', durationMs: Date.now() - startedMs,
          steps: stepResults.map((sr2) => ({ name: sr2.stepName, providerId: sr2.providerId, modelId: sr2.modelId, mode: sr2.mode, status: sr2.status, durationMs: sr2.durationMs, usage: sr2.usage, estimatedCost: sr2.estimatedCost })),
          warnings,
        });
        if (!jr.ok) warnings.push(jr.error);
      }
      return { ok: true, value: emptyResult };
    }
    const verdictPrompt = debateVerdictPrompt({ original: req.input, exchanges });
    const arbStart = Date.now();
    const arbChars = (verdictPrompt.system ?? '').length + verdictPrompt.user.length;
    const arbEstimate = guard.estimateCostUsd(arbChars, wf.limits.max_output_tokens, arbiter.provider, arbiter.model);
    const arbReservation = guard.reserve(arbEstimate, arbiter.provider, arbiter.model);
    let finalOutput: string | undefined;
    if (!arbReservation.ok) {
      warnings.push(arbReservation.error.message);
    } else {
      const synthetic = { name: 'arbiter', provider: arbiter.provider, model: arbiter.model } as StepConfig;
      const timeoutMs = Math.max(1, Math.min(arbiter.timeout_ms ?? 90_000, deadline - Date.now()));
      const call = await this.callWithRetry(synthetic, verdictPrompt, {
        timeoutMs, retries: wf.limits.max_retries_per_step, signal: opts.signal,
        maxOutputTokens: tokenCapFor(arbiter.evaluate, wf.limits.max_output_tokens),
      });
      const arbStep: StepResult = {
        stepId: 'arbiter', stepName: 'arbiter', providerId: arbiter.provider, modelId: arbiter.model,
        mode: modeOf(arbiter.provider), status: 'succeeded', startedAt: new Date(arbStart).toISOString(),
        durationMs: Date.now() - arbStart, checks: [],
      };
      if (!call.ok) {
        guard.release(arbReservation.value);
        arbStep.status = 'failed';
        arbStep.errorCode = call.error.code;
        warnings.push(`arbiter failed (${call.error.code}); falling back to debate transcript`);
        stepResults.push(arbStep);
      } else {
        const cost = guard.settle(arbReservation.value, call.value.usage, arbiter.provider, arbiter.model, arbChars, wf.limits.max_output_tokens);
        const baseChecks = arbiter.evaluate ?? ['non_empty' as const];
        const checks = runDeterministicChecks(call.value.content, baseChecks);
        arbStep.checks = checks;
        if (call.value.usage) arbStep.usage = call.value.usage;
        if (cost !== undefined) arbStep.estimatedCost = cost;
        if (checks.every((c) => c.passed)) {
          finalOutput = call.value.content;
          warnings.push(`debate: ${exchanges.length} exchange(s) across ${rounds} round(s); arbiter verdict delivered`);
          if (!/[。！？.!?!\]）"']$/.test(call.value.content.trim())) {
            warnings.push('arbiter verdict may be truncated by the token cap (does not end with terminal punctuation) — treat the tail as incomplete');
          }
          stepResults.push(arbStep);
        } else {
          const failed = checks.find((c) => !c.passed);
          const gate = maxCharsOf(arbiter.evaluate);
          // 0.13.3：仅 max_chars 超闸时做一次自校准压缩重试——用首次实测 字/token 比率精确钳住 token 上限
          if (failed?.checkId === 'max_chars' && gate !== undefined) {
            const ratio = call.value.usage?.outputTokens
              ? Math.min(Math.max(call.value.content.length / call.value.usage.outputTokens, 1), 3)
              : 2.2;
            const retryCap = Math.max(64, Math.ceil(gate / ratio));
            const retryPrompt = {
              system: verdictPrompt.system,
              user: `${verdictPrompt.user}\n\nHARD LIMIT: your previous attempt was ${call.value.content.length} chars; the verdict MUST stay under ${gate} chars. Compress while keeping the decision and its key reasons.`,
            };
            const retryStart = Date.now();
            const retryReserve = guard.reserve(
              guard.estimateCostUsd(arbChars, retryCap, arbiter.provider, arbiter.model),
              arbiter.provider, arbiter.model,
            );
            if (!retryReserve.ok) {
              arbStep.status = 'failed';
              warnings.push(`arbiter output rejected (max_chars ${call.value.content.length} > ${gate}); compress-retry skipped: ${retryReserve.error.message}`);
              stepResults.push(arbStep);
            } else {
              const retry = await this.callWithRetry(synthetic, retryPrompt, {
                timeoutMs: Math.max(1, Math.min(arbiter.timeout_ms ?? 90_000, deadline - Date.now())),
                retries: 0, signal: opts.signal, maxOutputTokens: retryCap,
              });
              const retryStep: StepResult = {
                stepId: 'arbiter-retry', stepName: 'arbiter', providerId: arbiter.provider, modelId: arbiter.model,
                mode: modeOf(arbiter.provider), status: 'succeeded', startedAt: new Date(retryStart).toISOString(),
                durationMs: Date.now() - retryStart, checks: [],
              };
              if (!retry.ok) {
                guard.release(retryReserve.value);
                arbStep.status = 'failed';
                retryStep.status = 'failed';
                retryStep.errorCode = retry.error.code;
                warnings.push(`arbiter rejected (max_chars ${call.value.content.length} > ${gate}) and compress-retry failed (${retry.error.code}); falling back to debate transcript`);
                stepResults.push(arbStep, retryStep);
              } else {
                const retryCost = guard.settle(retryReserve.value, retry.value.usage, arbiter.provider, arbiter.model, arbChars, retryCap);
                const retryChecks = runDeterministicChecks(retry.value.content, baseChecks);
                retryStep.checks = retryChecks;
                if (retry.value.usage) retryStep.usage = retry.value.usage;
                if (retryCost !== undefined) retryStep.estimatedCost = retryCost;
                if (retryChecks.every((c) => c.passed)) {
                  finalOutput = retry.value.content;
                  arbStep.status = 'failed';
                  warnings.push(`arbiter first attempt over max_chars (${call.value.content.length} > ${gate}); compress-retry delivered (${retry.value.content.length} chars)`);
                  if (!/[。！？.!?!\]）"']$/.test(retry.value.content.trim())) {
                    warnings.push('arbiter verdict may be truncated by the token cap (does not end with terminal punctuation) — treat the tail as incomplete');
                  }
                } else {
                  arbStep.status = 'failed';
                  retryStep.status = 'failed';
                  warnings.push(`arbiter rejected (max_chars) and compress-retry still over limit; falling back to debate transcript`);
                }
                stepResults.push(arbStep, retryStep);
              }
            }
          } else {
            arbStep.status = 'failed';
            warnings.push(`arbiter output rejected (${failed?.checkId ?? 'check'}: ${failed?.detail ?? ''}); falling back to debate transcript`);
            stepResults.push(arbStep);
          }
        }
      }
    }

    // 降级：辩论记录拼接
    if (finalOutput === undefined) {
      finalOutput = exchanges.length > 0
        ? exchanges.map((e) => `[${e.name}/${e.model} · ${e.round}]\n${e.content}`).join('\n\n---\n\n')
        : undefined;
    }

    // 终局立场一致性（辩论是否收敛）
    const agreement = answerAgreement([posA, posB].filter((p) => p.length > 0));

    const succeededOpenings = openings.filter((o) => o?.ok).length;
    const status: RunStatus = succeededOpenings > 0 ? 'succeeded' : 'failed';
    const stopReason: StopReason = succeededOpenings > 0 ? 'completed' : 'workflow_exhausted';
    const roundsHeld = stepResults.filter((sr2) => /-r\d+$/.test(sr2.stepId)).length / 2;
    warnings.push(`debate: ${succeededOpenings}/2 debaters opened, ${roundsHeld}/${rounds} rebuttal round(s) held`);

    if (guard.reserved > 0) warnings.push(`unreleased budget reservation: $${guard.reserved.toFixed(6)}`);

    const result: RunResult = {
      runId, status, finalOutput, steps: stepResults, stopReason, warnings,
      ...(agreement !== undefined ? { agreement } : {}),
    };

    if (opts.journal?.enabled) {
      const jr = opts.journal.append({
        v: 1, ts: new Date().toISOString(), runId, workflowId: req.workflowId,
        status, stopReason, durationMs: Date.now() - startedMs,
        steps: stepResults.map((s) => ({ name: s.stepName, providerId: s.providerId, modelId: s.modelId, mode: s.mode, status: s.status, durationMs: s.durationMs, usage: s.usage, estimatedCost: s.estimatedCost })),
        warnings,
      });
      if (!jr.ok) warnings.push(jr.error);
    }
    return { ok: true, value: result };
  }

  /**
   * MoA 聚合调用（ADR-0006 D6）：完整预算流程 + 独立 StepResult。
   * 聚合输出为自由文本，除 non_empty 外还执行 aggregate.evaluate 确定性检查
   * （0.12.2：成品此前无字数检查——「重写型步骤天然写长」的结构性缺口）；
   * 任何失败都以 err 返回，由调用方降级。
   */
  private async runAggregator(
    wf: WorkflowConfig,
    original: string,
    outputs: Array<{ name: string; model: string; content: string }>,
    o: { guard: BudgetGuard; deadline: number; signal: AbortSignal; maxOutputTokens: number; maxRetries: number; maxChars?: number },
  ): Promise<Result<{ content: string; step: StepResult; truncated?: boolean; extraSteps?: StepResult[] }, { warning: string; step?: StepResult }>> {
    const agg = wf.aggregate;
    if (!agg) return err({ warning: 'aggregate not configured' });
    if (!this.adapters.has(agg.provider)) {
      const pcfg = this.cfg.providers[agg.provider];
      if (!pcfg) return err({ warning: `aggregate provider "${agg.provider}" missing from config; falling back to concatenated comparison` });
      const created = createProvider(agg.provider, pcfg, this.credentials);
      if (!created.ok) return err({ warning: `aggregate adapter unavailable: ${created.error.message}` });
      this.adapters.set(agg.provider, created.value);
    }
    const mode = (() => {
      const p = this.cfg.providers[agg.provider];
      return p && p.kind !== 'mock' ? p.mode : ('byok' as AccessMode);
    })();

    const prompt = aggregatorPrompt({ original, candidates: outputs });
    const promptChars = (prompt.system ?? '').length + prompt.user.length;
    const estimate = o.guard.estimateCostUsd(promptChars, o.maxOutputTokens, agg.provider, agg.model);
    const reservation = o.guard.reserve(estimate, agg.provider, agg.model);
    if (!reservation.ok) return err({ warning: `aggregate skipped: ${reservation.error.message}` });

    const synthetic = { name: 'aggregate', provider: agg.provider, model: agg.model } as StepConfig;
    const stepStart = Date.now();
    const timeoutMs = Math.max(1, Math.min(agg.timeout_ms ?? 90_000, o.deadline - Date.now()));
    const call = await this.callWithRetry(synthetic, prompt, {
      timeoutMs,
      retries: o.maxRetries,
      signal: o.signal,
      maxOutputTokens: tokenCapFor(agg.evaluate, o.maxOutputTokens),
    });
    const failedStep = (detail: string, errorCode?: ProviderErrorCode): StepResult => ({
      stepId: 'aggregate',
      stepName: 'aggregate',
      providerId: agg.provider,
      modelId: agg.model,
      mode,
      status: 'failed',
      startedAt: new Date(stepStart).toISOString(),
      durationMs: Date.now() - stepStart,
      checks: [{ checkId: 'aggregate_output', passed: false, detail }],
      ...(errorCode !== undefined ? { errorCode } : {}),
    });
    if (!call.ok) {
      o.guard.release(reservation.value);
      return err({ warning: `aggregate call failed (${call.error.code}); falling back to concatenated comparison`, step: failedStep(`call failed: ${call.error.code}`, call.error.code) });
    }
    const cost = o.guard.settle(reservation.value, call.value.usage, agg.provider, agg.model, promptChars, o.maxOutputTokens);
    // 成品确定性检查（0.12.2）：aggregate.evaluate（缺省 non_empty）+ per-run maxChars 收紧
    const baseChecks = agg.evaluate ?? ['non_empty' as const];
    const tightened = o.maxChars === undefined
      ? baseChecks
      : baseChecks.map((c) => (typeof c === 'object' && 'max_chars' in c ? { max_chars: Math.min(c.max_chars, o.maxChars!) } : c));
    const checks = runDeterministicChecks(call.value.content, tightened);
    const okStep = (): StepResult => ({
      stepId: 'aggregate', stepName: 'aggregate', providerId: agg.provider, modelId: agg.model,
      mode, status: 'succeeded', startedAt: new Date(stepStart).toISOString(),
      durationMs: Date.now() - stepStart, checks, usage: call.value.usage,
      ...(cost !== undefined ? { estimatedCost: cost } : {}),
    });
    /** 0.14.1：截断检测（与裁决同款）——末尾无终止标点即疑似被 token 封顶切断 */
    const looksTruncated = (t: string): boolean => !/[。！？.!?!\]）"']$/.test(t.trim());

    if (checks.every((c) => c.passed)) {
      return ok({ content: call.value.content, step: okStep(), truncated: looksTruncated(call.value.content) });
    }

    const failed = checks.find((c) => !c.passed);
    const failedStepFull: StepResult = {
      ...failedStep(`${failed?.checkId ?? 'check'} failed: ${failed?.detail ?? ''}`),
      checks,
    };

    // 0.14.1：仅 max_chars 超闸时做一次自校准压缩重试（与辩论裁决同款——聚合此前只有拒绝降级）
    const gate = maxCharsOf(agg.evaluate);
    if (failed?.checkId === 'max_chars' && gate !== undefined) {
      const ratio = call.value.usage?.outputTokens
        ? Math.min(Math.max(call.value.content.length / call.value.usage.outputTokens, 1), 3)
        : 1.5;
      const retryCap = Math.max(64, Math.ceil(gate / ratio));
      const retryPrompt = {
        system: prompt.system,
        user: prompt.user + `\n\nHARD LIMIT: your previous attempt was ${call.value.content.length} chars; the final answer MUST stay under ${gate} chars. Compress while keeping the key points.`,
      };
      const retryReserve = o.guard.reserve(
        o.guard.estimateCostUsd(promptChars, retryCap, agg.provider, agg.model),
        agg.provider, agg.model,
      );
      if (retryReserve.ok) {
        const retryStart = Date.now();
        const retry = await this.callWithRetry(synthetic, retryPrompt, {
          timeoutMs: Math.max(1, Math.min(agg.timeout_ms ?? 90_000, o.deadline - Date.now())),
          retries: 0, signal: o.signal, maxOutputTokens: retryCap,
        });
        if (retry.ok) {
          const retryCost = o.guard.settle(retryReserve.value, retry.value.usage, agg.provider, agg.model, promptChars, retryCap);
          const retryChecks = runDeterministicChecks(retry.value.content, tightened);
          const retryOk = retryChecks.every((c) => c.passed);
          const retryStep: StepResult = {
            stepId: 'aggregate-retry', stepName: 'aggregate', providerId: agg.provider, modelId: agg.model,
            mode, status: retryOk ? 'succeeded' : 'failed',
            startedAt: new Date(retryStart).toISOString(), durationMs: Date.now() - retryStart,
            checks: retryChecks, usage: retry.value.usage,
            ...(retryCost !== undefined ? { estimatedCost: retryCost } : {}),
          };
          if (retryOk) {
            return ok({
              content: retry.value.content,
              step: retryStep,
              truncated: looksTruncated(retry.value.content),
              extraSteps: [failedStepFull],
            });
          }
          return err({
            warning: `aggregate rejected (max_chars ${call.value.content.length} > ${gate}) and compress-retry still over limit; falling back to concatenated comparison`,
            step: failedStepFull,
          });
        }
        o.guard.release(retryReserve.value);
      }
    }

    return err({
      warning: `aggregate output rejected (${failed?.checkId ?? 'check'}: ${failed?.detail ?? ''}); falling back to concatenated comparison`,
      step: failedStepFull,
    });
  }

  /** 估算整个工作流的最坏情况费用（P2-④ 人工批准用） */
  private estimateWorkflowCost(wf: WorkflowConfig, input: string): number | undefined {
    const guard = new BudgetGuard(undefined, true, makePriceBook(this.cfg));
    let total = 0;
    let hasUnknown = false;
    for (const step of wf.steps) {
      const promptChars = input.length + (step.input === 'review_template' ? 300 : step.input === 'revision_template' ? 600 : 0);
      const est = guard.estimateCostUsd(promptChars, wf.limits.max_output_tokens, step.provider, step.model);
      if (est === undefined) { hasUnknown = true; continue; }
      total += est * (1 + (step.max_retries ?? wf.limits.max_retries_per_step));
    }
    // 修订循环放大（ADR-0006 D3）：每多一轮 ≈ 重跑评审+修订两步（按平均步价近似），整体不翻倍
    if (wf.limits.max_revisions > 1 && wf.steps.length > 0) {
      const avgStep = total / wf.steps.length;
      total += avgStep * 2 * (wf.limits.max_revisions - 1);
    }
    // debate 放大（ADR-0006 D7）：开场×2 已在 steps 内，反驳轮再 ×rounds，双方计
    if (wf.strategy === 'debate' && wf.steps.length > 0) {
      const avgStep = total / wf.steps.length;
      total += avgStep * 2 * wf.rounds;
    }
    // 引擎生成调用（judge/aggregate，ADR-0006 D1/D6/D7）：prompt ≈ 原任务 + 全部候选/辩论记录
    for (const t of [wf.judge, wf.aggregate]) {
      if (!t) continue;
      const multiplier = wf.strategy === 'debate' ? 2 + wf.rounds * 2 : wf.steps.length + 1;
      const est = guard.estimateCostUsd(input.length * multiplier, wf.limits.max_output_tokens, t.provider, t.model);
      if (est === undefined) { hasUnknown = true; continue; }
      total += est * (1 + wf.limits.max_retries_per_step);
    }
    return hasUnknown ? undefined : total;
  }

  private async callWithRetry(
    step: StepConfig,
    prompt: { system?: string; user: string },
    o: { timeoutMs: number; retries: number; signal: AbortSignal; maxOutputTokens: number },
  ): Promise<Result<ProviderChatResponse, ProviderError & { attempts: number }>> {
    const adapter = this.adapters.get(step.provider);
    if (!adapter) {
      return err({ code: 'invalid_request', message: `no adapter available for provider "${step.provider}"`, retryable: false, attempts: 0 });
    }
    let attempt = 0;
    for (;;) {
      const inner = new AbortController();
      const propagate = () => inner.abort();
      o.signal.addEventListener('abort', propagate, { once: true });
      const timer = setTimeout(() => inner.abort(), o.timeoutMs);
      let outcome: Result<ProviderChatResponse, ProviderError>;
      try {
        outcome = await adapter.chat({
          modelId: step.model,
          system: prompt.system,
          user: prompt.user,
          maxOutputTokens: o.maxOutputTokens,
          timeoutMs: o.timeoutMs,
          signal: inner.signal,
        });
      } finally {
        clearTimeout(timer);
        o.signal.removeEventListener('abort', propagate);
      }
      if (o.signal.aborted) {
        return err({ code: 'timeout', message: 'run cancelled while awaiting the provider', retryable: false, attempts: attempt + 1 });
      }
      if (outcome.ok) return outcome;
      const e = outcome.error;
      if (!e.retryable || attempt >= o.retries) {
        return err({ ...e, attempts: attempt + 1 });
      }
      const backoff = Math.min(Math.max(RETRY_BACKOFF_BASE_MS * 2 ** attempt, e.retryAfterMs ?? 0), RETRY_BACKOFF_CAP_MS);
      await abortableDelay(backoff, o.signal);
      if (o.signal.aborted) {
        return err({ code: 'timeout', message: 'run cancelled during retry backoff', retryable: false, attempts: attempt + 1 });
      }
      attempt++;
    }
  }
}

function runStatusFor(stopReason: StopReason): RunStatus {
  switch (stopReason) {
    case 'completed':
      return 'succeeded';
    case 'cancelled':
      return 'cancelled';
    case 'timed_out':
      return 'timed_out';
    case 'budget_exceeded':
      return 'budget_exceeded';
    default:
      return 'failed';
  }
}

function stepResult(
  idx: number,
  step: StepConfig,
  status: RunStatus,
  startedAtMs: number,
  extra?: { usage?: Usage; estimatedCost?: number; checks?: CheckResult[]; errorCode?: ProviderErrorCode },
): StepResult {
  const r: StepResult = {
    stepId: `${idx + 1}.${step.name}`,
    stepName: step.name,
    providerId: step.provider,
    modelId: step.model,
    status,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    checks: extra?.checks ?? [],
  };
  if (extra?.usage) r.usage = extra.usage;
  if (extra?.estimatedCost !== undefined) r.estimatedCost = extra.estimatedCost;
  if (extra?.errorCode) r.errorCode = extra.errorCode;
  return r;
}

function skippedResult(idx: number, step: StepConfig): StepResult {
  return {
    stepId: `${idx + 1}.${step.name}`,
    stepName: step.name,
    providerId: step.provider,
    modelId: step.model,
    status: 'skipped',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    checks: [],
  };
}

/** user_overrides 只能收紧；放宽被钳制并告警（基线 §6） */
function applyOverrides(
  wf: WorkflowConfig,
  o: UserOverrides | undefined,
  warnings: string[],
): { maxSteps: number; totalTimeoutMs: number; maxCostUsd: number | undefined; maxChars: number | undefined } {
  let maxSteps = wf.limits.max_steps;
  let totalTimeoutMs = wf.limits.total_timeout_ms;
  let maxCostUsd = wf.limits.max_cost_usd;
  let maxChars: number | undefined = undefined;
  if (o?.maxSteps !== undefined) {
    const requested = Math.max(1, Math.floor(o.maxSteps));
    if (requested > wf.limits.max_steps) {
      warnings.push(`user override maxSteps=${o.maxSteps} exceeds configured ${wf.limits.max_steps}; clamped (overrides may only tighten)`);
    }
    maxSteps = Math.min(requested, wf.limits.max_steps);
  }
  if (o?.totalTimeoutMs !== undefined) {
    const requested = Math.max(1, Math.floor(o.totalTimeoutMs));
    if (requested > wf.limits.total_timeout_ms) {
      warnings.push(`user override totalTimeoutMs=${o.totalTimeoutMs} exceeds configured ${wf.limits.total_timeout_ms}; clamped`);
    }
    totalTimeoutMs = Math.min(requested, wf.limits.total_timeout_ms);
  }
  if (o?.maxCostUsd !== undefined) {
    const requested = Math.max(0, o.maxCostUsd);
    if (maxCostUsd !== undefined && requested > maxCostUsd) {
      warnings.push(`user override maxCostUsd=${o.maxCostUsd} exceeds configured ${maxCostUsd}; clamped`);
    }
    maxCostUsd = maxCostUsd === undefined ? requested : Math.min(requested, maxCostUsd);
  }
  if (o?.maxChars !== undefined && o.maxChars >= 1) {
    maxChars = Math.floor(o.maxChars);
  }
  return { maxSteps, totalTimeoutMs, maxCostUsd, maxChars };
}

/** P0：非 USD 定价视为价格未知（ADR-0001）；P1：runtime.fx 可换算（ADR-0003 D1） */
export function makePriceBook(cfg: BayzeConfig): (providerId: string, modelId: string) => PriceInfo | undefined {
  const fx = cfg.runtime.fx;
  return (providerId, modelId) => {
    const p = cfg.providers[providerId];
    if (!p) return undefined;
    const m = p.models.find((x) => x.id === modelId);
    if (!m?.pricing) return undefined;
    const cur = m.pricing.currency.toUpperCase();
    if (cur === 'USD') {
      return { inputPer1m: m.pricing.input_per_1m_tokens, outputPer1m: m.pricing.output_per_1m_tokens };
    }
    // P1：配置了汇率则换算为 USD（ADR-0003 D1）
    if (fx && cur === 'CNY') {
      return {
        inputPer1m: m.pricing.input_per_1m_tokens * fx.rate_to_usd,
        outputPer1m: m.pricing.output_per_1m_tokens * fx.rate_to_usd,
      };
    }
    return undefined;
  };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
