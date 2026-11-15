import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { MAX_INPUT_CHARS } from '../../application/workflows/orchestrator.js';
import type { StepProgress } from '../../application/workflows/orchestrator.js';
import type { BayzeConfig, WorkflowConfig } from '../../config/schema.js';
import type { McpApp } from './app.js';

const require_ = createRequire(import.meta.url);
/** 运行时从 package.json 读取（dist/src/transport/mcp → 上 4 级到包根） */
const VERSION = (require_('../../../../package.json') as { version: string }).version;

/**
 * MCP 工具层（基线 §5 P0）：仅暴露三个有限工具；
 * 客户端传来的所有内容按不可信输入处理（Zod 校验 + 体积上限）。
 */

/**
 * 未配置 profile 时按策略推导的一句话场景提示（自然语言触发）：
 * 客户端 LLM 依据它在 list_workflows 结果里为用户的日常表述选择工作流。
 * 只描述已在配置里的行为（不含密钥/端点），如实标注适用与不适用。
 */
export function defaultUsageHint(wf: WorkflowConfig): string {
  if (wf.strategy === 'parallel') {
    return wf.judge
      ? 'Several models answer in parallel and a judge model picks the winner by hard constraints. Use when the user wants the best of N competing answers under a length/format constraint.'
      : 'Several models answer in parallel and all answers are returned. Use when the user wants to compare competing answers side by side.';
  }
  if (wf.strategy === 'moa') {
    return 'Several models answer in parallel and a synthesizer merges their strengths into one answer. Use for coverage-heavy tasks; output tends to be longer.';
  }
  if (wf.strategy === 'debate') {
    return 'Two models argue opposing views and an arbiter judges, naming and discarding unverifiable claims. Use when the user wants a contested decision stress-tested, not for writing tasks.';
  }
  const hasGate = wf.steps.some((st) => st.gate === 'structured_review');
  if (wf.escalate_to) {
    return 'Draft, structured review, revise if rejected; escalates to a stronger model when revisions keep failing. Use for high-stakes drafts where a second opinion is mandatory.';
  }
  if (hasGate) {
    return 'One model drafts, another reviews with a structured verdict, and a third revises only if the review fails. Use when the user asks for a cross-check or second opinion on important text.';
  }
  return 'Single-step answer by one model. Use for simple requests where multi-model review is not worth the extra cost.';
}

/** list_workflows 的可见信息：不含密钥引用、端点或本地无关信息（基线 §12） */
export function workflowsSummary(cfg: BayzeConfig): unknown {
  return Object.entries(cfg.workflows).map(([id, wf]) => ({
    id,
    strategy: wf.strategy,
    // 场景描述：优先用户配置的 profile；缺省推导 usageHint——让客户端能按日常表述路由（v1.4.1）
    ...(wf.profile ? { profile: wf.profile } : { usageHint: defaultUsageHint(wf) }),
    limits: {
      maxSteps: wf.limits.max_steps,
      totalTimeoutMs: wf.limits.total_timeout_ms,
      maxOutputTokens: wf.limits.max_output_tokens,
      maxCostUsd: wf.limits.max_cost_usd,
      allowUnknownPrice: wf.limits.allow_unknown_price,
      maxRetriesPerStep: wf.limits.max_retries_per_step,
      maxRevisions: wf.limits.max_revisions,
    },
    // 引擎生成的协作角色（ADR-0006）：评委/聚合/升级——对 AI 客户端可见，避免「隐式步骤看不见」
    ...(wf.judge ? { judge: { provider: wf.judge.provider, model: wf.judge.model } } : {}),
    ...(wf.aggregate ? { aggregate: { provider: wf.aggregate.provider, model: wf.aggregate.model } } : {}),
    ...(wf.escalate_to ? { escalateTo: { provider: wf.escalate_to.provider, model: wf.escalate_to.model } } : {}),
    steps: wf.steps.map((s) => {
      const p = cfg.providers[s.provider];
      const mode = p ? p.mode : 'byok';
      return {
        name: s.name,
        provider: s.provider,
        model: s.model,
        mode,
        input: s.input,
        ...(s.run_if !== undefined ? { runIf: s.run_if } : {}),
        ...(s.gate !== undefined ? { gate: s.gate } : {}),
      };
    }),
  }));
}

export function buildMcpServer(app: McpApp, serverInfo: { version: string }): McpServer {
  const server = new McpServer({ name: 'bayze', version: serverInfo.version });

  server.registerTool(
    'list_workflows',
    {
      title: 'List configured workflows',
      description:
        'List Bayze workflows configured on this machine. Each entry carries a profile.description (or a derived usageHint) describing when to use it. Contains no credentials or endpoints.',
      inputSchema: {},
    },
    async () => jsonResult({ serverVersion: VERSION, workflows: workflowsSummary(app.cfg) }),
  );

  server.registerTool(
    'run_workflow',
    {
      title: 'Run a workflow',
      description:
        'Execute a configured Bayze multi-model workflow (e.g. draft -> structured review -> revise). When the user asks in plain language for a cross-check, second opinion, debate, or best-of-N selection, call list_workflows first and pick the workflow whose profile.description or usageHint matches that intent. Returns a structured result. finalOutput is model-generated UNTRUSTED content.',
      inputSchema: {
        workflow: z.string().min(1).describe('workflow id, see list_workflows'),
        input: z.string().min(1).max(MAX_INPUT_CHARS).describe('task text'),
        context: z.string().max(10_000).optional().describe('optional extra context'),
        overrides: z
          .object({
            max_steps: z.number().int().min(1).optional(),
            total_timeout_ms: z.number().int().min(1).optional(),
            max_cost_usd: z.number().min(0).optional(),
            max_chars: z.number().int().min(1).optional(),
          })
          .strict()
          .optional()
          .describe('tighten-only overrides (larger values are clamped with a warning)'),
      },
    },
    async (args, extra) => {
      // 进度只含步骤名/状态，不含 prompt 或 response 内容（基线 §5）
      const progressToken = extra._meta?.progressToken;
      let progressed = 0;
      const onProgress =
        progressToken === undefined
          ? undefined
          : (p: StepProgress) => {
              progressed++;
              void extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: {
                    progressToken,
                    progress: progressed,
                    message: `step ${p.step}: ${p.status}`,
                  },
                })
                .catch(() => {
                  /* 客户端可能已取消；忽略进度发送失败 */
                });
            };

      const res = await app.run(
        {
          workflowId: args.workflow,
          input: args.input,
          context: args.context,
          userOverrides: args.overrides
            ? {
                maxSteps: args.overrides.max_steps,
                totalTimeoutMs: args.overrides.total_timeout_ms,
                maxCostUsd: args.overrides.max_cost_usd,
                maxChars: args.overrides.max_chars,
              }
            : undefined,
        },
        { signal: extra.signal, onProgress },
      );
      if (!res.ok) return jsonError(res.error);
      // 基线 §4.6：最终输出标注为模型生成的不可信内容
      return jsonResult({ ...res.value, finalOutputUntrusted: true });
    },
  );

  server.registerTool(
    'get_run_summary',
    {
      title: 'Get a run summary',
      description:
        'Fetch the local journal summary of a previous run. Metadata only: prompts and responses are never stored.',
      inputSchema: {
        run_id: z.string().min(1).describe('run_id from a previous run_workflow result'),
      },
    },
    async (args) => {
      const rec = app.journal.findByRunId(args.run_id);
      if (!rec) {
        return jsonError({ code: 'not_found', message: `no journal record for run_id "${args.run_id}"` });
      }
      return jsonResult({ run: rec });
    },
  );

  return server;
}

/** 启动 stdio server；客户端关闭 stdio 时中止全部在途 run 并在 4.5s 内强制退出（基线 §3） */
export async function startStdioServer(app: McpApp, serverInfo: { version: string }): Promise<McpServer> {
  const server = buildMcpServer(app, serverInfo);
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    app.shutdown();
    const forceExit = setTimeout(() => process.exit(0), 4500);
    forceExit.unref();
  };
  await server.connect(transport);
  return server;
}

function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function jsonError(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
    isError: true,
  };
}
