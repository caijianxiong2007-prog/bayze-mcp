// Bayze 内部统一类型（基线规范 v0.3 §6「内部统一请求/响应」）

export type RunStatus =
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'budget_exceeded'
  | 'timed_out';

export type StopReason =
  | 'completed'
  | 'overloaded'
  | 'draft_check_failed'
  | 'missing_required_input'
  | 'budget_exceeded'
  | 'cancelled'
  | 'workflow_exhausted'
  | 'review_failed'
  | 'timed_out';

export type ProviderErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'invalid_request'
  | 'provider_unavailable'
  | 'content_blocked'
  | 'unknown';

/** 升级触发原因；确定性检查采用 `check_failed:<check_id>` 结构化形式（基线 §12） */
export type TriggerReason =
  | 'schema_invalid'
  | 'quality_gate_failed'
  | 'provider_timeout'
  | 'rate_limit'
  | `check_failed:${string}`
  | `provider_error:${string}`;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CheckResult {
  checkId: string;
  passed: boolean;
  detail?: string;
}

/** 仅允许收紧限制（基线 §6）；放宽类覆盖在引擎层拒绝 */
export interface UserOverrides {
  totalTimeoutMs?: number;
  maxSteps?: number;
  maxCostUsd?: number;
}

export interface RunRequest {
  workflowId: string;
  input: string;
  context?: string;
  userOverrides?: UserOverrides;
}

export interface StepResult {
  stepId: string;
  stepName: string;
  providerId: string;
  modelId: string;
  status: RunStatus;
  startedAt: string; // ISO-8601
  durationMs: number;
  usage?: Usage;
  /** USD；无法估算时省略并写入 warnings（基线 §6） */
  estimatedCost?: number;
  checks: CheckResult[];
  errorCode?: ProviderErrorCode;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  /** 最终模型输出，视为生成内容/不可信内容（基线 §4.6） */
  finalOutput?: string;
  steps: StepResult[];
  stopReason: StopReason;
  triggerReason?: TriggerReason;
  warnings: string[];
  /** 最近一次结构化评审结论（若有）；模型意见而非事实保证（基线 §7） */
  reviewSummary?: { verdict: 'accept' | 'revise'; reasons: string[] };
}
