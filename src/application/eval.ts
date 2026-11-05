import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { BayzeConfig } from '../config/schema.js';
import type { WorkflowOrchestrator } from '../application/workflows/orchestrator.js';
import type { RunResult, Usage } from '../domain/types.js';

/**
 * 离线评测运行器（后续计划 v1.0 增量 C/D）：
 * 读取任务集 → 逐条通过指定工作流执行 → 汇总 token/费用/延迟/成功率
 * 用于对比 quick_answer 基线 vs review_then_revise 路由的成本差异。
 */

export interface EvalTask {
  id: string;
  category: string;
  input: string;
  constraints?: { max_chars?: number };
}

export interface EvalTaskResult {
  id: string;
  category: string;
  status: string;
  durationMs: number;
  estimatedCost?: number;
  usage?: Usage;
  mode?: string;
  stepsExecuted: number;
}

export interface EvalSummary {
  workflow: string;
  totalTasks: number;
  succeeded: number;
  failed: number;
  successRate: string;
  totalDurationMs: number;
  avgDurationMs: number;
  totalEstimatedCost?: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byCategory: Record<string, { count: number; succeeded: number; avgCost?: number; avgDurationMs: number }>;
  tasks: EvalTaskResult[];
}

export function loadTasks(path: string): EvalTask[] {
  const raw = readFileSync(path, 'utf8');
  const tasks = JSON.parse(raw);
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(`eval task file "${path}" must be a non-empty JSON array`);
  }
  return tasks as EvalTask[];
}

export async function runEvaluation(
  orchestrator: WorkflowOrchestrator,
  cfg: BayzeConfig,
  workflowId: string,
  tasks: EvalTask[],
): Promise<EvalSummary> {
  const results: EvalTaskResult[] = [];
  let totalCost: number | undefined = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalDuration = 0;
  let succeeded = 0;
  const byCategory: EvalSummary['byCategory'] = {};

  for (const task of tasks) {
    const r = await orchestrator.run(
      { workflowId, input: task.input },
      { signal: new AbortController().signal },
    );
    if (!r.ok) {
      results.push({ id: task.id, category: task.category, status: `setup_error:${r.error.code}`, durationMs: 0, stepsExecuted: 0 });
      continue;
    }
    const run: RunResult = r.value;
    const taskDuration = run.steps.reduce((n, s) => n + s.durationMs, 0);
    const taskCost = run.steps.reduce((n, s) => n + (s.estimatedCost ?? 0), 0);
    const taskUsage = run.steps.reduce(
      (acc, s) => ({
        inputTokens: acc.inputTokens + (s.usage?.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (s.usage?.outputTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0 } as Usage,
    );
    const stepsExecuted = run.steps.filter((s) => s.status !== 'skipped').length;
    const ok = run.status === 'succeeded';
    if (ok) succeeded++;
    totalCost = totalCost === undefined ? undefined : totalCost + taskCost;
    totalInput += taskUsage.inputTokens;
    totalOutput += taskUsage.outputTokens;
    totalDuration += taskDuration;

    results.push({
      id: task.id,
      category: task.category,
      status: run.status,
      durationMs: taskDuration,
      estimatedCost: taskCost > 0 ? taskCost : undefined,
      usage: taskUsage.inputTokens > 0 ? taskUsage : undefined,
      mode: run.steps[0]?.mode,
      stepsExecuted,
    });

    const cat = byCategory[task.category] ??= { count: 0, succeeded: 0, avgCost: 0, avgDurationMs: 0 };
    cat.count++;
    if (ok) cat.succeeded++;
    cat.avgCost = (cat.avgCost ?? 0) + taskCost;
    cat.avgDurationMs += taskDuration;
  }

  for (const cat of Object.values(byCategory)) {
    cat.avgCost = cat.avgCost && cat.count ? cat.avgCost / cat.count : undefined;
    cat.avgDurationMs = cat.count ? Math.round(cat.avgDurationMs / cat.count) : 0;
  }

  return {
    workflow: workflowId,
    totalTasks: tasks.length,
    succeeded,
    failed: tasks.length - succeeded,
    successRate: `${((succeeded / tasks.length) * 100).toFixed(1)}%`,
    totalDurationMs: totalDuration,
    avgDurationMs: tasks.length ? Math.round(totalDuration / tasks.length) : 0,
    totalEstimatedCost: totalCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    byCategory,
    tasks: results,
  };
}

export function formatEvalComparison(baseline: EvalSummary, candidate: EvalSummary): string {
  const lines = [
    `# 成本对比：${baseline.workflow} (基线) vs ${candidate.workflow} (候选)`,
    '',
    '| 指标 | 基线 | 候选 | 差异 |',
    '|---|---|---|---|',
    `| 成功率 | ${baseline.successRate} | ${candidate.successRate} | ${candidate.succeeded - baseline.succeeded > 0 ? '+' : ''}${candidate.succeeded - baseline.succeeded} |`,
    `| 总费用 (USD) | ${baseline.totalEstimatedCost?.toFixed(6) ?? 'N/A'} | ${candidate.totalEstimatedCost?.toFixed(6) ?? 'N/A'} | ${candidate.totalEstimatedCost !== undefined && baseline.totalEstimatedCost !== undefined ? ((candidate.totalEstimatedCost - baseline.totalEstimatedCost).toFixed(6)) : 'N/A'} |`,
    `| 平均延迟 (ms) | ${baseline.avgDurationMs} | ${candidate.avgDurationMs} | ${candidate.avgDurationMs - baseline.avgDurationMs > 0 ? '+' : ''}${candidate.avgDurationMs - baseline.avgDurationMs} |`,
    `| 总 input tokens | ${baseline.totalInputTokens} | ${candidate.totalInputTokens} | ${candidate.totalInputTokens - baseline.totalInputTokens} |`,
    `| 总 output tokens | ${baseline.totalOutputTokens} | ${candidate.totalOutputTokens} | ${candidate.totalOutputTokens - baseline.totalOutputTokens} |`,
  ];
  const cats = new Set([...Object.keys(baseline.byCategory), ...Object.keys(candidate.byCategory)]);
  if (cats.size > 1) {
    lines.push('', '## 按类别');
    lines.push('| 类别 | 基线成功/总数 | 候选成功/总数 | 基线均费 | 候选均费 |');
    lines.push('|---|---|---|---|---|');
    for (const cat of cats) {
      const b = baseline.byCategory[cat];
      const c = candidate.byCategory[cat];
      lines.push(`| ${cat} | ${b ? `${b.succeeded}/${b.count}` : '-'} | ${c ? `${c.succeeded}/${c.count}` : '-'} | ${b?.avgCost?.toFixed(6) ?? '-'} | ${c?.avgCost?.toFixed(6) ?? '-'} |`);
    }
  }
  return lines.join('\n');
}

void randomUUID;
