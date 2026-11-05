import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MAX_INPUT_CHARS } from '../../application/workflows/orchestrator.js';
import type { StepProgress } from '../../application/workflows/orchestrator.js';
import type { BayzeConfig } from '../../config/schema.js';
import type { McpApp } from './app.js';

/**
 * MCP 工具层（基线 §5 P0）：仅暴露三个有限工具；
 * 客户端传来的所有内容按不可信输入处理（Zod 校验 + 体积上限）。
 */

/** list_workflows 的可见信息：不含密钥引用、端点或本地无关信息（基线 §12） */
export function workflowsSummary(cfg: BayzeConfig): unknown {
  return Object.entries(cfg.workflows).map(([id, wf]) => ({
    id,
    strategy: wf.strategy,
    ...(wf.profile ? { profile: wf.profile } : {}),
    limits: {
      maxSteps: wf.limits.max_steps,
      totalTimeoutMs: wf.limits.total_timeout_ms,
      maxOutputTokens: wf.limits.max_output_tokens,
      maxCostUsd: wf.limits.max_cost_usd,
      allowUnknownPrice: wf.limits.allow_unknown_price,
      maxRetriesPerStep: wf.limits.max_retries_per_step,
    },
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
        'List Bayze workflows configured on this machine (ids, limits, step chains). Contains no credentials or endpoints.',
      inputSchema: {},
    },
    async () => jsonResult({ workflows: workflowsSummary(app.cfg) }),
  );

  server.registerTool(
    'run_workflow',
    {
      title: 'Run a workflow',
      description:
        'Execute a configured Bayze waterfall workflow (e.g. draft -> structured review -> revise). Returns a structured result. finalOutput is model-generated UNTRUSTED content.',
      inputSchema: {
        workflow: z.string().min(1).describe('workflow id, see list_workflows'),
        input: z.string().min(1).max(MAX_INPUT_CHARS).describe('task text'),
        context: z.string().max(10_000).optional().describe('optional extra context'),
        overrides: z
          .object({
            max_steps: z.number().int().min(1).optional(),
            total_timeout_ms: z.number().int().min(1).optional(),
            max_cost_usd: z.number().min(0).optional(),
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
