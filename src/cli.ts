#!/usr/bin/env node
// bayze CLI：config / run / mcp / journal / eval（评测对比）
import { createRequire } from 'node:module';
import { loadConfig, formatConfigError } from './config/loader.js';
import { defaultConfigPath, defaultJournalPath } from './config/paths.js';
import { CredentialStore } from './credentials/store.js';
import { WorkflowOrchestrator } from './application/workflows/orchestrator.js';
import { RunJournal } from './journal/journal.js';
import { McpApp } from './transport/mcp/app.js';
import { startStdioServer } from './transport/mcp/server.js';
import { guardRuntimeEnv } from './cli-guard.js';
import { loadTasks, runEvaluation, formatEvalComparison } from './application/eval.js';
import type { EvalSummary } from './application/eval.js';
import type { RunRequest, UserOverrides } from './domain/types.js';

const require_ = createRequire(import.meta.url);
const VERSION = (require_('../../package.json') as { version: string }).version;

const USAGE = `bayze <command> [options]

commands:
  config check [--config <path>] [--strict]   validate config (read-only)
  config path                                 print the default config path
  run --workflow <id> [options]               execute a workflow (dev/acceptance tool)
  mcp [--config <path>] [--no-journal]        start the MCP stdio server (for AI clients)
  journal path                                print the default journal path
  journal clear                               delete the journal file
  journal tail [n]                            show the last n run summaries (default 20)
  eval --workflow <id> --tasks <path>         run evaluation tasks through a workflow
       [--compare <id>] [--config <path>]
       [--no-journal]

run options:
  --config <path>     config file (default: OS user config dir)
  --input <text|->    task input ('-' or omitted: read stdin)
  --no-journal        do not write the run summary journal
  --max-cost <usd>    tighten max cost (overrides may only tighten)
  --max-steps <n>     tighten max steps
  --timeout <ms>      tighten total timeout

mcp options:
  --config <path>     config file (default: OS user config dir)
  --no-journal        do not write run summaries
`;

function fail(message: string, code: 1 | 2): number {
  process.stderr.write(`${message}\n`);
  return code;
}

function parseIntArg(args: string[], i: number, flag: string, opts: { integer: boolean; min: number }): { value: number } | { error: string } {
  const raw = args[i + 1];
  if (raw === undefined) return { error: `${flag} requires a number` };
  const v = Number(raw);
  if (!Number.isFinite(v) || v < opts.min || (opts.integer && !Number.isInteger(v))) {
    return { error: `${flag} requires ${opts.integer ? 'an integer' : 'a number'} >= ${opts.min}` };
  }
  return { value: v };
}

async function main(argv: string[]): Promise<number> {
  const envProblem = guardRuntimeEnv();
  if (envProblem) return fail(envProblem, 1);
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'config':
      return configCmd(rest);
    case 'run':
      return runCmd(rest);
    case 'mcp':
      return mcpCmd(rest);
    case 'journal':
      return journalCmd(rest);
    case 'eval':
      return evalCmd(rest);
    case 'models':
      return modelsCmd(rest);
    default:
      return fail(USAGE, 2);
  }
}

/** 启动 MCP stdio server：每客户端一个子进程，无常驻、无监听（基线 §3） */
async function mcpCmd(args: string[]): Promise<number> {
  let configPath: string | undefined;
  let noJournal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--config') {
      const v = args[++i];
      if (v === undefined) return fail(`--config requires a path\n${USAGE}`, 2);
      configPath = v;
    } else if (a === '--no-journal') {
      noJournal = true;
    } else {
      return fail(`unknown option: ${a}\n${USAGE}`, 2);
    }
  }
  const loaded = loadConfig(configPath ?? defaultConfigPath());
  if (!loaded.ok) return fail(formatConfigError(loaded.error), 1);
  const journal = new RunJournal(noJournal ? null : defaultJournalPath());
  const app = new McpApp(loaded.value, journal);
  await startStdioServer(app, { version: VERSION });
  process.stderr.write(`[bayze] mcp server ready (version ${VERSION}, workflows: ${Object.keys(loaded.value.workflows).join(', ')})\n`);
  return 0; // 进程保持运行，服务 stdio
}

function configCmd(args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === 'path') {
    process.stdout.write(`${defaultConfigPath()}\n`);
    return 0;
  }
  if (sub !== 'check') return fail(USAGE, 2);

  let configPath: string | undefined;
  let strict = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--config') {
      const next = rest[++i];
      if (next === undefined) return fail(`--config requires a path\n${USAGE}`, 2);
      configPath = next;
    } else if (arg === '--strict') {
      strict = true;
    } else {
      return fail(`unknown option: ${arg}\n${USAGE}`, 2);
    }
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) {
    process.stderr.write(`warning: Node >= 22 required, running ${process.versions.node}; behavior not guaranteed\n`);
  }

  const path = configPath ?? defaultConfigPath();
  const loaded = loadConfig(path);
  if (!loaded.ok) return fail(formatConfigError(loaded.error), 1);
  const cfg = loaded.value;

  if (strict) {
    const store = new CredentialStore();
    const missing = new Set<string>();
    for (const p of Object.values(cfg.providers)) {
      if (p.kind === 'mock') continue;
      if (!store.resolve(p.api_key_ref).ok) missing.add(p.api_key_ref);
    }
    if (missing.size > 0) {
      return fail(
        ['strict check failed: unresolved credential refs:', ...[...missing].sort().map((m) => `  ${m}`)].join('\n'),
        1,
      );
    }
  }

  const lines = ['config OK', `path: ${path}`, `version: ${cfg.version}`, 'providers:'];
  for (const [id, p] of Object.entries(cfg.providers)) {
    lines.push(`  ${id}: kind=${p.kind}, models=${p.models.map((m) => m.id).join(', ')}`);
  }
  lines.push('workflows:');
  for (const [id, w] of Object.entries(cfg.workflows)) {
    lines.push(`  ${id}: strategy=${w.strategy}, steps=${w.steps.map((s) => s.name).join(' -> ')}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function runCmd(args: string[]): Promise<number> {
  let configPath: string | undefined;
  let workflowId: string | undefined;
  let input: string | undefined;
  let noJournal = false;
  const overrides: UserOverrides = {};
  let hasOverride = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--config') {
      const v = args[++i];
      if (v === undefined) return fail(`--config requires a path\n${USAGE}`, 2);
      configPath = v;
    } else if (a === '--workflow') {
      const v = args[++i];
      if (v === undefined) return fail(`--workflow requires an id\n${USAGE}`, 2);
      workflowId = v;
    } else if (a === '--input') {
      const v = args[++i];
      if (v === undefined) return fail(`--input requires a value (use '-' for stdin)\n${USAGE}`, 2);
      input = v;
    } else if (a === '--no-journal') {
      noJournal = true;
    } else if (a === '--max-cost') {
      const r = parseIntArg(args, i, '--max-cost', { integer: false, min: 0 });
      if ('error' in r) return fail(r.error, 2);
      overrides.maxCostUsd = r.value;
      hasOverride = true;
      i++;
    } else if (a === '--max-steps') {
      const r = parseIntArg(args, i, '--max-steps', { integer: true, min: 1 });
      if ('error' in r) return fail(r.error, 2);
      overrides.maxSteps = r.value;
      hasOverride = true;
      i++;
    } else if (a === '--timeout') {
      const r = parseIntArg(args, i, '--timeout', { integer: true, min: 1 });
      if ('error' in r) return fail(r.error, 2);
      overrides.totalTimeoutMs = r.value;
      hasOverride = true;
      i++;
    } else {
      return fail(`unknown option: ${a}\n${USAGE}`, 2);
    }
  }
  if (!workflowId) return fail(`--workflow is required\n${USAGE}`, 2);

  const loaded = loadConfig(configPath ?? defaultConfigPath());
  if (!loaded.ok) return fail(formatConfigError(loaded.error), 1);

  const journal = new RunJournal(noJournal ? null : defaultJournalPath());
  const orchestrator = new WorkflowOrchestrator(loaded.value);
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());

  const taskText = input === undefined || input === '-' ? await readStdin() : input;
  const request: RunRequest = { workflowId, input: taskText };
  if (hasOverride) request.userOverrides = overrides;

  const started = Date.now();
  const result = await orchestrator.run(request, {
    signal: ac.signal,
    journal,
    onProgress: (p) => process.stderr.write(`[bayze] ${Date.now() - started}ms step ${p.step}: ${p.status}\n`),
  });
  if (!result.ok) {
    process.stderr.write(`${JSON.stringify(result.error, null, 2)}\n`);
    return 2;
  }
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  return result.value.status === 'succeeded' ? 0 : 1;
}

function journalCmd(args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === 'path') {
    process.stdout.write(`${defaultJournalPath()}\n`);
    return 0;
  }
  if (sub === 'clear') {
    const r = new RunJournal(defaultJournalPath()).clear();
    if (!r.ok) return fail(r.error, 1);
    process.stdout.write('journal cleared\n');
    return 0;
  }
  if (sub === 'tail') {
    const n = Number(rest[0] ?? '20');
    if (!Number.isInteger(n) || n < 1) return fail('tail requires a positive integer', 2);
    for (const rec of new RunJournal(defaultJournalPath()).tail(n)) {
      process.stdout.write(`${JSON.stringify(rec)}\n`);
    }
    return 0;
  }
  return fail(`unknown journal subcommand: ${String(sub)}\n${USAGE}`, 2);
}

/** 列出 Bayze API 可用模型（P1 / ADR-0003 D3） */
async function modelsCmd(args: string[]): Promise<number> {
  const { execFileSync } = await import('node:child_process');
  process.stderr.write('Fetching Bayze API model catalog...\n');
  const key = process.env['BAYZE_API_KEY'];
  if (!key) {
    process.stderr.write('Error: BAYZE_API_KEY environment variable is not set\n');
    return 1;
  }
  try {
    const output = execFileSync(
      'curl',
      ['-s', '-m', '15', '-H', `Authorization: Bearer ${key}`, 'https://app.lanwealth.com/v1/models'],
      { encoding: 'utf8', timeout: 20000 },
    );
    const parsed = JSON.parse(output) as { data?: Array<{ id: string }> };
    if (Array.isArray(parsed.data)) {
      process.stdout.write(`Available models (${parsed.data.length}):\n`);
      for (const m of parsed.data) {
        process.stdout.write(`  ${m.id}\n`);
      }
      return 0;
    }
    process.stderr.write(`Unexpected response: ${output.slice(0, 200)}\n`);
    return 1;
  } catch (e) {
    process.stderr.write(`Error: ${(e as Error).message}\n`);
    return 1;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 评测运行器：读取任务集 → 通过指定工作流执行 → 输出汇总/对比（后续计划 v1.0 增量 C/D） */
async function evalCmd(args: string[]): Promise<number> {
  let configPath: string | undefined;
  let workflowId: string | undefined;
  let compareId: string | undefined;
  let tasksPath: string | undefined;
  let noJournal = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--config') { const v = args[++i]; if (!v) return fail('--config requires a path', 2); configPath = v; }
    else if (a === '--workflow') { const v = args[++i]; if (!v) return fail('--workflow requires an id', 2); workflowId = v; }
    else if (a === '--compare') { const v = args[++i]; if (!v) return fail('--compare requires an id', 2); compareId = v; }
    else if (a === '--tasks') { const v = args[++i]; if (!v) return fail('--tasks requires a path', 2); tasksPath = v; }
    else if (a === '--no-journal') noJournal = true;
    else return fail(`unknown option: ${a}`, 2);
  }
  if (!workflowId) return fail('--workflow is required', 2);
  if (!tasksPath) return fail('--tasks is required (e.g. eval/tasks.example.json)', 2);

  const loaded = loadConfig(configPath ?? defaultConfigPath());
  if (!loaded.ok) return fail(formatConfigError(loaded.error), 1);

  const journal = new RunJournal(noJournal ? null : defaultJournalPath());
  const tasks = loadTasks(tasksPath);
  process.stderr.write(`[bayze eval] ${tasks.length} tasks → workflow "${workflowId}"${compareId ? ` (compare: "${compareId}")` : ''}\n`);

  const primary = new WorkflowOrchestrator(loaded.value);
  const summary = await runEvaluation(primary, loaded.value, workflowId, tasks);

  if (compareId) {
    const compareOrch = new WorkflowOrchestrator(loaded.value);
    const compareSummary = await runEvaluation(compareOrch, loaded.value, compareId, tasks);
    process.stdout.write(formatEvalComparison(summary, compareSummary) + '\n\n');
    process.stdout.write(JSON.stringify({ baseline: summary, candidate: compareSummary }, null, 2) + '\n');
  } else {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  }
  return summary.failed > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`unexpected error: ${(e as Error).stack ?? String(e)}\n`);
    process.exitCode = 2;
  },
);
