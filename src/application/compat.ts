import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowOrchestrator } from '../application/workflows/orchestrator.js';
import { configSchema, type BayzeConfig } from '../config/schema.js';
import { loadConfig, formatConfigError } from '../config/loader.js';
import type { RunResult, StepResult } from '../domain/types.js';

/**
 * 兼容性矩阵 runner（v1.3.0 试点）：
 * 对配置内全部 openai-compatible 模型 × 3 个办公工作流 × 每工作流 2 个代表性任务
 * 实测运行，产出 docs/compatibility.md + compatibility.json。
 *
 * 记录字段（按用户验收口径）：供应商、精确模型 ID、测试日期、角色、完成情况、
 * 评审可解析性、质量分（人工列，首版留空）、费用、耗时、限制。
 *
 * 注意：这是首轮试点实测记录，不是「兼容所有模型」的承诺。
 */

interface MatrixRow {
  workflow: string;
  provider: string;
  model: string;
  role: string;
  promptId: string;
  status: string;
  stopReason?: string;
  parseableVerdict?: boolean;
  costUsd: number;
  durationMs: number;
  date: string;
  notes: string;
}

const PILOT_PROMPTS = {
  cross_review: [
    '用不超过 120 字介绍 bayze-mcp 这个 MCP 服务器，必须提到"本地优先"和"预算守卫"。',
    '把这句话翻译成英文（≤25 词，保留"评审门"和"预算守卫"两概念，问句形式）：Bayze 的评审门让团队敢把多模型串起来用，预算守卫兜底成本。',
  ],
  constrained: [
    '用不超过 150 字的中文介绍 MCP 协议的价值。',
    'Write in English, max 30 words: why deterministic checks beat model self-reporting for length limits.',
  ],
};

/** 从给定 config 提取全部模型（provider, model）对与固定评审者 */
function extractModels(cfg: BayzeConfig, includeMock = false): Array<{ provider: string; model: string; label: string }> {
  const out: Array<{ provider: string; model: string; label: string }> = [];
  for (const [pid, p] of Object.entries(cfg.providers)) {
    if (p.kind === 'mock' && !includeMock) continue;
    for (const m of p.models) {
      if (m.id === 'deepseek-reasoner') continue; // 排除推理模型（成本/耗时高一个量级）
      out.push({ provider: pid, model: m.id, label: `${pid}/${m.id}` });
    }
  }
  return out;
}

export async function runCompatMatrix(baseConfigPath: string, outDir: string, opts: { runs: number; includeMock?: boolean }): Promise<number> {
  const base = loadConfig(baseConfigPath);
  if (!base.ok) {
    process.stderr.write(`${formatConfigError(base.error)}\n`);
    return 1;
  }
  const cfg = base.value;
  const models = extractModels(cfg, opts.includeMock);
  if (models.length === 0) {
    process.stderr.write('no non-mock models found in config\n');
    return 1;
  }

  const rows: MatrixRow[] = [];

  // 动态构造 compat 工作流注入 cfg 副本（v1.3.1 修复：不再要求用户预生成 compat 工作流）
  const cfgAny = cfg as unknown as { workflows: Record<string, unknown> };
  const reviewerModel: Record<string, string> = {};
  const reviewerProvider: Record<string, string> = {};
  for (const m of models) {
    const wfId = `compat_cross_review_${m.model.replace(/[^a-z0-9]/gi, '_')}`;
    // 评审者 = 配置内第一个非被测模型（DeepSeek 优先）
    const reviewer = models.find((x) => x.model !== m.model && /deepseek|qwen/i.test(x.model)) ?? models.find((x) => x.model !== m.model);
    if (!reviewer) continue;
    reviewerModel[wfId] = reviewer.model;
    reviewerProvider[wfId] = reviewer.provider;
    cfgAny.workflows[wfId] = {
      strategy: 'waterfall',
      limits: {
        max_steps: 3, total_timeout_ms: 120000, max_output_tokens: 2000,
        max_cost_usd: 0.05, allow_unknown_price: true, max_retries_per_step: 1,
      },
      steps: [
        { name: 'draft', provider: m.provider, model: m.model, input: 'original', timeout_ms: 60000, evaluate: [{ max_chars: 6000 }] },
        { name: 'review', provider: reviewer.provider, model: reviewer.model, input: 'review_template', timeout_ms: 60000, run_if: 'always', gate: 'structured_review', review_schema: ['verdict', 'reasons'] },
        { name: 'revise', provider: m.provider, model: m.model, input: 'revision_template', timeout_ms: 60000, run_if: 'review_verdict_is_revise', evaluate: [{ max_chars: 6000 }] },
      ],
    };
    cfgAny.workflows[`compat_constrained_${m.model.replace(/[^a-z0-9]/gi, '_')}`] = {
      strategy: 'waterfall',
      limits: { max_steps: 1, total_timeout_ms: 60000, max_output_tokens: 2000, max_cost_usd: 0.02, allow_unknown_price: true },
      steps: [
        { name: 'single', provider: m.provider, model: m.model, input: 'original', timeout_ms: 60000, evaluate: [{ max_chars: 400 }] },
      ],
    };
  }

  const orch = new WorkflowOrchestrator(cfgAny as unknown as BayzeConfig);

  for (const m of models) {
    const wfCross = `compat_cross_review_${m.model.replace(/[^a-z0-9]/gi, '_')}`;
    const wfCons = `compat_constrained_${m.model.replace(/[^a-z0-9]/gi, '_')}`;
    for (let i = 0; i < PILOT_PROMPTS.cross_review.length; i++) {
      const prompt = PILOT_PROMPTS.cross_review[i]!;
      if (!cfgAny.workflows[wfCross]) continue;
      const r = await orch.run({ workflowId: wfCross, input: prompt }, { signal: new AbortController().signal });
      if (r.ok) {
        const reviewStep = r.value.steps.find((s) => s.stepName === 'review');
        const cost = r.value.steps.reduce((t, s) => t + (s.estimatedCost ?? 0), 0);
        rows.push({
          workflow: 'cross_review', provider: m.provider, model: m.model, role: 'draft+revise',
          promptId: `cross_review#${i + 1}`, status: r.value.status, stopReason: r.value.stopReason,
          parseableVerdict: r.value.reviewSummary !== undefined, costUsd: cost,
          durationMs: r.value.steps.reduce((t, s) => t + s.durationMs, 0), date: new Date().toISOString().slice(0, 10),
          notes: '',
        });
        void reviewStep;
      }
    }
    for (let i = 0; i < PILOT_PROMPTS.constrained.length; i++) {
      const prompt = PILOT_PROMPTS.constrained[i]!;
      if (!cfgAny.workflows[wfCons]) continue;
      const r = await orch.run({ workflowId: wfCons, input: prompt }, { signal: new AbortController().signal });
      if (r.ok) {
        const cost = r.value.steps.reduce((t, s) => t + (s.estimatedCost ?? 0), 0);
        rows.push({
          workflow: 'constrained', provider: m.provider, model: m.model, role: 'single',
          promptId: `constrained#${i + 1}`, status: r.value.status, stopReason: r.value.stopReason,
          costUsd: cost, durationMs: r.value.steps.reduce((t, s) => t + s.durationMs, 0),
          date: new Date().toISOString().slice(0, 10), notes: '',
        });
      }
    }
  }

  // 产出 compatibility.json + 更新 docs/compatibility.md 标记区间
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const docsMd = join(outDir, 'compatibility.md');
  writeFileSync(join(outDir, 'compatibility.json'), JSON.stringify({ generated: new Date().toISOString(), rows }, null, 2));
  const tableLines = rows.map((r) =>
    `| ${r.workflow} | ${r.provider}/${r.model} | ${r.role} | ${r.promptId} | ${r.date} | ${r.status} | ${r.parseableVerdict ?? '—'} | $${r.costUsd.toFixed(4)} | ${r.durationMs}ms | ${r.notes || '—'} |`);
  if (existsSync(docsMd)) {
    const md = readFileSync(docsMd, 'utf8');
    const start = md.indexOf('<!-- COMPAT-TABLE-START -->');
    const end = md.indexOf('<!-- COMPAT-TABLE-END -->');
    if (start >= 0 && end > start) {
      const updated =
        md.slice(0, start) +
        '<!-- COMPAT-TABLE-START -->\n' + tableLines.join('\n') + '\n' + md.slice(end);
      writeFileSync(docsMd, updated);
      process.stdout.write(`\nupdated ${docsMd} (${rows.length} rows)\n`);
      return 0;
    }
  }
  // 兜底：无标记文件时独立生成
  const mdPath = join(outDir, 'compatibility-standalone.md');
  writeFileSync(mdPath, renderMarkdown(rows));
  process.stdout.write(`\nwrote ${mdPath} (${rows.length} rows)\n`);
  return 0;
}

function renderMarkdown(rows: MatrixRow[]): string {
  const head = `# 兼容性矩阵（首轮试点实测）\n\n> 本表是首轮试点实测记录，不是「兼容所有模型」的承诺。质量列为人工评判列，首版留空待填。\n\n`;
  const lines = rows.map((r) =>
    `| ${r.workflow} | ${r.provider}/${r.model} | ${r.role} | ${r.promptId} | ${r.date} | ${r.status} | ${r.parseableVerdict ?? '—'} | $${r.costUsd.toFixed(4)} | ${r.durationMs}ms | ${r.notes || '—'} |`,
  );
  return (
    head +
    `| 工作流 | 供应商/模型 | 角色 | 任务 | 日期 | 状态 | 评审可解析 | 费用 | 耗时 | 限制 |\n|---|---|---|---|---|---|---|---|---|---|\n` +
    lines.join('\n') +
    '\n'
  );
}
