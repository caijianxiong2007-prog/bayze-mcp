import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * bayze init 向导（v1.1.0）：交互式生成配置文件与凭据。
 *
 * 设计约束（基线 §8）：
 * - 配置文件只含 env: 引用，Key 本体写独立 .env 文件（600 权限）
 * - 生成的配置必须通过 configSchema 校验（fail-closed：不合格不落盘）
 * - 不引入新依赖：readline 内置模块做交互
 */

export interface InitAnswers {
  providers: Array<{
    id: string;
    apiKey: string;
    envVar: string;
    models: string[];
    baseUrl?: string;
  }>;
  defaultWorkflow: 'quick_answer' | 'review_then_revise';
  maxCostUsd: number;
  targetDir: string;
}

/** 供应商预设：base_url、模型、Key 注册页、env 变量名（基线经验值） */
export const PROVIDER_PRESETS: Record<
  string,
  { label: string; baseUrl: string; models: string[]; envVar: string; signupUrl: string; currency: string; inputPerM: number; outputPerM: number }
> = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    envVar: 'BAYZE_DEEPSEEK_API_KEY',
    signupUrl: 'https://platform.deepseek.com',
    currency: 'CNY',
    inputPerM: 2.0,
    outputPerM: 8.0,
  },
  dashscope: {
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo'],
    envVar: 'BAYZE_DASHSCOPE_API_KEY',
    signupUrl: 'https://dashscope.console.aliyun.com',
    currency: 'CNY',
    inputPerM: 0.8,
    outputPerM: 2.0,
  },
  ark: {
    label: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-2-1-lite-260915'],
    envVar: 'BAYZE_ARK_API_KEY',
    signupUrl: 'https://console.volcengine.com/ark',
    currency: 'CNY',
    inputPerM: 0.3,
    outputPerM: 0.6,
  },
  anthropic: {
    label: 'Claude',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
    envVar: 'BAYZE_ANTHROPIC_API_KEY',
    signupUrl: 'https://console.anthropic.com',
    currency: 'USD',
    inputPerM: 3.0,
    outputPerM: 15.0,
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
    envVar: 'BAYZE_OPENAI_API_KEY',
    signupUrl: 'https://platform.openai.com',
    currency: 'USD',
    inputPerM: 2.5,
    outputPerM: 10.0,
  },
  bayze: {
    label: 'Bayze 统一 API',
    baseUrl: 'https://app.lanwealth.com/v1',
    models: ['deepseek-chat', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
    envVar: 'BAYZE_API_KEY',
    signupUrl: 'https://app.lanwealth.com/auth/login',
    currency: 'USD',
    inputPerM: 0.14,
    outputPerM: 0.28,
  },
};

/** 从答案生成 config.yaml 内容（YAML 文本，供预览+落盘） */
export function renderConfigYaml(ans: InitAnswers): string {
  const lines: string[] = [
    '# bayze-mcp 配置（由 bayze init 生成）',
    '# 密钥只存 ~/.bayze/.env（600 权限）；本文件只含 env: 引用',
    '# 文档：https://github.com/caijianxiong2007-prog/bayze-mcp',
    '',
    'version: 1',
    '',
    'runtime:',
    '  max_concurrency: 2',
    '  max_queue_size: 4',
    '',
    'providers:',
  ];
  for (const p of ans.providers) {
    const preset = PROVIDER_PRESETS[p.id];
    if (!preset) throw new Error(`unknown provider id: ${p.id}`);
    lines.push(`  ${p.id}:`);
    lines.push(`    kind: openai-compatible`);
    if (p.baseUrl ?? preset.baseUrl) lines.push(`    base_url: "${p.baseUrl ?? preset.baseUrl}"`);
    lines.push(`    api_key_ref: "env:${p.envVar}"`);
    lines.push(`    models:`);
    for (const m of preset.models) {
      lines.push(`      - id: ${m}`);
      lines.push(`        pricing: { currency: ${preset.currency}, input_per_1m_tokens: ${preset.inputPerM}, output_per_1m_tokens: ${preset.outputPerM} }`);
    }
    lines.push('');
  }

  // 按选中的供应商生成工作流
  if (ans.providers.length === 0) throw new Error('at least one provider is required');
  const first = ans.providers[0]!;
  const hasReview = ans.providers.length >= 2;
  lines.push('workflows:');
  lines.push('  quick_answer:');
  lines.push('    strategy: waterfall');
  lines.push('    profile: { category: general, quality_tier: fast, description: "快速回答/翻译——单模型一步完成" }');
  lines.push('    limits:');
  lines.push('      max_steps: 1');
  lines.push('      total_timeout_ms: 45000');
  lines.push('      max_output_tokens: 8000');
  lines.push('      max_cost_usd: 0.02');
  const anyNonUsd = ans.providers.some((p) => PROVIDER_PRESETS[p.id]!.currency !== 'USD');
  const firstModel = PROVIDER_PRESETS[first.id]!.models[0]!;
  lines.push(`      allow_unknown_price: ${anyNonUsd}`);
  lines.push('    steps:');
  lines.push(`      - name: answer`);
  lines.push(`        provider: ${first.id}`);
  lines.push(`        model: ${firstModel}`);
  lines.push(`        input: original`);
  lines.push(`        timeout_ms: 45000`);
  lines.push(`        evaluate: [non_empty, { max_chars: 20000 }]`);
  lines.push('');

  if (hasReview) {
    const a = ans.providers[0]!;
    const b = ans.providers[1]!;
    const revise = ans.providers[2] ?? b;
    const aModel = PROVIDER_PRESETS[a.id]!.models[0]!;
    const bModel = PROVIDER_PRESETS[b.id]!.models[0]!;
    const rModel = PROVIDER_PRESETS[revise.id]!.models[0]!;
    lines.push('  review_then_revise:');
    lines.push('    strategy: waterfall');
    lines.push('    profile: { category: general, quality_tier: high, description: "跨厂商复核——起草→评审→按需修订" }');
    lines.push('    limits:');
    lines.push('      max_steps: 3');
    lines.push('      total_timeout_ms: 120000');
    lines.push('      max_output_tokens: 8000');
    lines.push('      max_cost_usd: 0.20');
    lines.push(`      allow_unknown_price: ${anyNonUsd}`);
    lines.push('      max_retries_per_step: 1');
    lines.push('    steps:');
    lines.push(`      - name: draft`);
    lines.push(`        provider: ${a.id}`);
    lines.push(`        model: ${aModel}`);
    lines.push(`        input: original`);
    lines.push(`        timeout_ms: 45000`);
    lines.push(`        evaluate: [non_empty, { max_chars: 20000 }]`);
    lines.push(`      - name: review`);
    lines.push(`        provider: ${b.id}`);
    lines.push(`        model: ${bModel}`);
    lines.push(`        input: review_template`);
    lines.push(`        timeout_ms: 45000`);
    lines.push(`        run_if: always`);
    lines.push(`        gate: structured_review`);
    lines.push(`        review_schema: [verdict, reasons]`);
    lines.push(`      - name: revise`);
    lines.push(`        provider: ${revise.id}`);
    lines.push(`        model: ${rModel}`);
    lines.push(`        input: revision_template`);
    lines.push(`        timeout_ms: 90000`);
    lines.push(`        run_if: review_verdict_is_revise`);
    lines.push(`        evaluate: [non_empty, { max_chars: 20000 }]`);
    lines.push('');
  }
  return lines.join('\n');
}

/** 从答案生成 .env 内容（Key 本体，600 权限单独存放） */
export function renderDotEnv(ans: InitAnswers): string {
  return ans.providers.map((p) => `${p.envVar}=${p.apiKey}`).join('\n') + '\n';
}

/** 生成 Cherry Studio MCP 注册 JSON（复制到剪贴板用） */
export function renderCherryJson(ans: InitAnswers): string {
  return JSON.stringify(
    {
      mcpServers: {
        bayze: {
          command: 'npx',
          args: ['-y', 'bayze-mcp', 'mcp', '--config', join(ans.targetDir, 'config.yaml')],
        },
      },
    },
    null,
    2,
  );
}

/** 生成结果：写 config.yaml + .env（600 权限），目录不存在则创建 */
export function writeInitFiles(ans: InitAnswers): Result<
  { configPath: string; envPath: string; configOk: true },
  { message: string }
> {
  const yaml = renderConfigYaml(ans);
  const env = renderDotEnv(ans);
  const dir = ans.targetDir;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'config.yaml');
    const envPath = join(dir, '.env');
    // 防覆盖：已有配置时不静默覆盖
    if (existsSync(configPath)) {
      return err({ message: `config already exists at ${configPath}; delete or rename it first, or pass a different directory` });
    }
    writeFileSync(configPath, yaml, 'utf8');
    writeFileSync(envPath, env, { encoding: 'utf8', mode: 0o600 });
    return ok({ configPath, envPath, configOk: true });
  } catch (e) {
    return err({ message: `write failed: ${(e as Error).message}` });
  }
}

/** .env 加载：把 KEY=VALUE 注入 process.env（init 生成的文件，供后续命令使用） */
export function loadDotEnv(envPath: string): number {
  if (!existsSync(envPath)) return 0;
  const text = readFileSync(envPath, 'utf8');
  let count = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    const key = m?.[1];
    const value = m?.[2];
    if (key && value !== undefined && !process.env[key]) {
      process.env[key] = value.trim();
      count++;
    }
  }
  return count;
}

// 最小 Result 类型（避免向导模块依赖 domain/errors 造成循环）
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}
function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}
