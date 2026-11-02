import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpApp } from '../../src/transport/mcp/app.js';
import { buildMcpServer } from '../../src/transport/mcp/server.js';
import { configSchema } from '../../src/config/schema.js';
import type { BayzeConfig } from '../../src/config/schema.js';
import { RunJournal } from '../../src/journal/journal.js';
import { MAX_INPUT_CHARS } from '../../src/application/workflows/orchestrator.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- 测试夹具使用宽松类型 */

const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function fixtureConfig(runtime: Record<string, unknown> = {}, limits: Record<string, unknown> = {}): BayzeConfig {
  return configSchema.parse({
    version: 1,
    runtime,
    providers: {
      mockmain: {
        kind: 'mock',
        models: [
          { id: 'mock-success', pricing: { currency: 'USD', input_per_1m_tokens: 0, output_per_1m_tokens: 0 } },
          { id: 'mock-review-accept', pricing: { currency: 'USD', input_per_1m_tokens: 0, output_per_1m_tokens: 0 } },
          { id: 'mock-hang', pricing: { currency: 'USD', input_per_1m_tokens: 0, output_per_1m_tokens: 0 } },
        ],
      },
      'example-remote': {
        kind: 'openai-compatible',
        base_url: 'https://provider.example/v1',
        api_key_ref: 'env:BAYZE_EXAMPLE_API_KEY',
        models: [{ id: 'example-model' }],
      },
    },
    workflows: {
      w: {
        strategy: 'waterfall',
        limits: { max_steps: 3, total_timeout_ms: 5000, max_output_tokens: 1000, ...limits },
        steps: [
          { name: 'draft', provider: 'mockmain', model: 'mock-success', input: 'original', timeout_ms: 1000, evaluate: ['non_empty'] },
          { name: 'review', provider: 'mockmain', model: 'mock-review-accept', input: 'review_template', timeout_ms: 1000, run_if: 'always', gate: 'structured_review', review_schema: ['verdict', 'reasons'] },
          { name: 'revise', provider: 'mockmain', model: 'mock-success', input: 'revision_template', timeout_ms: 1000, run_if: 'review_verdict_is_revise' },
        ],
      },
      hang: {
        strategy: 'waterfall',
        limits: { max_steps: 1, total_timeout_ms: 5000, max_output_tokens: 1000 },
        steps: [{ name: 'draft', provider: 'mockmain', model: 'mock-hang', input: 'original', timeout_ms: 400, evaluate: ['non_empty'] }],
      },
    },
  });
}

async function makeClient(cfg: BayzeConfig, journalPath: string | null): Promise<{ app: McpApp; client: Client; close: () => Promise<void> }> {
  const app = new McpApp(cfg, new RunJournal(journalPath));
  const server = buildMcpServer(app, { version: 'test' });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { app, client, close: async () => void (await client.close()) };
}

function tmpJournal(): string {
  return join(mkdtempSync(join(tmpdir(), 'bayze-mcp-')), 'journal.jsonl');
}

type ToolRes = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: any;
  isError?: boolean;
};

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  options?: { onprogress?: (p: { progress: number; total?: number; message?: string }) => void },
): Promise<ToolRes> {
  return (await client.callTool({ name, arguments: args }, undefined, options)) as unknown as ToolRes;
}

test('工具发现：恰好三个工具', async () => {
  const dir = tmpJournal();
  try {
    const { client, close } = await makeClient(fixtureConfig(), dir);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((t) => t.name).sort(),
      ['get_run_summary', 'list_workflows', 'run_workflow'],
    );
    await close();
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('list_workflows：可见工作流，不泄露 api_key_ref / base_url', async () => {
  const dir = tmpJournal();
  try {
    const { client, close } = await makeClient(fixtureConfig(), dir);
    const res = await callTool(client, 'list_workflows', {});
    const text = res.content?.[0]?.text ?? '';
    const payload = JSON.parse(text) as { workflows: Array<{ id: string }> };
    assert.ok(payload.workflows.some((w) => w.id === 'w'));
    assert.ok(!text.includes('api_key_ref'));
    assert.ok(!text.includes('base_url'));
    assert.ok(!text.includes('provider.example'));
    await close();
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('run_workflow：accept 路径，结果标注 finalOutputUntrusted', async () => {
  const dir = tmpJournal();
  try {
    const { client, close } = await makeClient(fixtureConfig(), dir);
    const res = await callTool(client, 'run_workflow', { workflow: 'w', input: 'hello mcp' });
    const payload = res.structuredContent as any;
    assert.equal(res.isError, undefined);
    assert.equal(payload.status, 'succeeded');
    assert.equal(payload.reviewSummary?.verdict, 'accept');
    assert.equal(payload.finalOutputUntrusted, true);
    assert.ok(typeof payload.runId === 'string' && payload.runId.length > 0);
    await close();
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('run_workflow：未知工作流 → 结构化错误结果', async () => {
  const dir = tmpJournal();
  try {
    const { client, close } = await makeClient(fixtureConfig(), dir);
    const res = await callTool(client, 'run_workflow', { workflow: 'ghost', input: 'x' });
    assert.equal(res.isError, true);
    const payload = res.structuredContent as any;
    assert.equal(payload.code, 'unknown_workflow');
    await close();
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('run_workflow：输入超限被 schema 拒绝（结构化错误结果）', async () => {
  const dir = tmpJournal();
  try {
    const { client, close } = await makeClient(fixtureConfig(), dir);
    const res = await callTool(client, 'run_workflow', { workflow: 'w', input: 'x'.repeat(MAX_INPUT_CHARS + 1) });
    assert.equal(res.isError, true);
    const text = res.content?.[0]?.text ?? '';
    assert.match(text, /input/); // zod 错误体定位到 input 字段
    await close();
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('run_workflow：进度通知只含步骤名/状态，不含任务文本', async () => {
  const dir = tmpJournal();
  try {
    const { client, close } = await makeClient(fixtureConfig(), dir);
    const messages: string[] = [];
    await callTool(client, 'run_workflow', { workflow: 'w', input: 'SECRET-TASK-TEXT' }, {
      onprogress: (p) => {
        if (p.message) messages.push(p.message);
      },
    });
    assert.ok(messages.length >= 2, `expected progress messages, got ${messages.length}`);
    assert.ok(messages.every((m) => /^step [\w-]+: (running|succeeded|failed|skipped)$/.test(m)));
    assert.ok(!messages.some((m) => m.includes('SECRET-TASK-TEXT')));
    await close();
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('并发满且队列空：第二个 run 返回 overloaded 结构化错误', async () => {
  const dir = tmpJournal();
  try {
    const { client, close } = await makeClient(fixtureConfig({ max_concurrency: 1, max_queue_size: 0 }), dir);
    const first = callTool(client, 'run_workflow', { workflow: 'hang', input: 'x' });
    await new Promise((r) => setTimeout(r, 30)); // 等第一个真正占住并发槽
    const second = await callTool(client, 'run_workflow', { workflow: 'w', input: 'y' });
    assert.equal(second.isError, true);
    const payload = second.structuredContent as any;
    assert.equal(payload.code, 'overloaded');
    await first;
    await close();
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('get_run_summary：能查到刚完成的 run；查不到时结构化 not_found', async () => {
  const dir = tmpJournal();
  try {
    const { client, close } = await makeClient(fixtureConfig(), dir);
    const run = await callTool(client, 'run_workflow', { workflow: 'w', input: 'summarize me' });
    const runId = (run.structuredContent as any).runId as string;
    const found = await callTool(client, 'get_run_summary', { run_id: runId });
    const payload = found.structuredContent as any;
    assert.equal(payload.run?.runId, runId);
    assert.ok(!('finalOutput' in payload.run));

    const missing = await callTool(client, 'get_run_summary', { run_id: 'no-such-run' });
    assert.equal(missing.isError, true);
    assert.equal((missing.structuredContent as any).code, 'not_found');
    await close();
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('McpApp：外部取消信号传播为 cancelled', async () => {
  const dir = tmpJournal();
  try {
    const app = new McpApp(fixtureConfig({}, { total_timeout_ms: 60000 }), new RunJournal(dir));
    const ac = new AbortController();
    const p = app.run({ workflowId: 'hang', input: 'x' }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const r = await p;
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.status, 'cancelled');
      assert.equal(r.value.stopReason, 'cancelled');
    }
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('端到端：真实 stdio 子进程可发现并调用工具', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(PROJECT_ROOT, 'dist/src/cli.js'),
      'mcp',
      '--config',
      join(PROJECT_ROOT, 'examples/config.example.yaml'),
      '--no-journal',
    ],
  });
  const client = new Client({ name: 'e2e-client', version: '0.0.0' });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 3);
    const res = await callTool(client, 'run_workflow', { workflow: 'review_then_revise_mock', input: '端到端测试' });
    const payload = res.structuredContent as any;
    assert.equal(payload.status, 'succeeded');
    assert.equal(payload.finalOutputUntrusted, true);
  } finally {
    await client.close();
  }
});
