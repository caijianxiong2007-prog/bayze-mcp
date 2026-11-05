import { randomUUID } from 'node:crypto';
import { err } from '../../domain/errors.js';
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
import { renderStepPrompt } from './templates.js';
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

    // parallel 策略：多模型同时执行同一任务（P1 / ADR-0005 D1）
    if (wf.strategy === 'parallel') {
      return this.runParallel(wf, req, opts);
    }

    // P2-④ 人工批准：预估总费用超过门槛且用户未确认 → 暂停
    if (wf.limits.approval_threshold_usd !== undefined && req.userOverrides?.approved !== true) {
      const estTotal = this.estimateWorkflowCost(wf, req.input);
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

    const modeOf = (providerId: string): AccessMode => {
      const p = this.cfg.providers[providerId];
      return p && p.kind !== 'mock' ? p.mode : 'byok';
    };

    for (let idx = 0; idx < wf.steps.length; idx++) {
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
        original: req.input,
        previousOutput: lastSuccessOutput,
        reviewFeedback: reviewSummary,
        reviewSchemaFields: step.review_schema ?? ['verdict', 'reasons'],
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
        if (reviewSummary?.verdict === 'revise') reviseDelivered = true;
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
    }

    // 未执行到的步骤补记 skipped，保持步骤清单完整
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
      warnings.push('Bayze API 模式：本地费用仅为估算，实际扣费以 https://app.lanwealth.com 账单为准');
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
      const checks = runDeterministicChecks(call.value.content, step.evaluate);
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

    // finalOutput = 所有成功输出的拼接对比
    const finalOutput = outputs.length > 0
      ? outputs.map((o) => `[${o.name}/${o.model}]\n${o.content}`).join('\n\n---\n\n')
      : undefined;

    const succeededCount = outputs.length;
    const status: RunStatus = succeededCount > 0 ? 'succeeded' : 'failed';
    const stopReason: StopReason = succeededCount > 0 ? 'completed' : 'workflow_exhausted';
    warnings.push(`parallel: ${succeededCount}/${wf.steps.length} models succeeded`);

    if (guard.reserved > 0) warnings.push(`unreleased budget reservation: $${guard.reserved.toFixed(6)}`);

    const result: RunResult = { runId, status, finalOutput, steps: stepResults, stopReason, warnings };

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
