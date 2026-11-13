import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadDotEnv, PROVIDER_PRESETS, writeInitFiles, renderCherryJson, renderConfigYaml } from './config/init.js';
import { loadConfig, formatConfigError } from './config/loader.js';

/** bayze init 向导（v1.1.0）：交互式生成配置与凭据，最后自动校验 */
export async function initCmd(args: string[]): Promise<number> {
  let targetDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') { targetDir = args[++i]; }
    else if (args[i] === '--help' || args[i] === '-h') {
      process.stdout.write(`bayze init [--dir <directory>]    交互式生成配置文件（默认 ~/.bayze）\n`);
      return 0;
    }
    else return fail(`unknown option: ${args[i]}`, 2);
  }
  const dir = targetDir ?? defaultBayzeDir();

  // v1.1.1：TTY 用交互 readline；管道（非 TTY）先读全部 stdin 入队列——
  // readline/promises 在管道 EOF 时会丢弃未消费的缓冲行
  let pipeQueue: string[] | null = null;
  const ask = async (prompt: string): Promise<string> => {
    if (stdin.isTTY) {
      const rl = createInterface({ input: stdin, output: stdout });
      const v = await rl.question(prompt);
      rl.close();
      return v;
    }
    if (pipeQueue === null) {
      const chunks: Buffer[] = [];
      for await (const c of stdin) chunks.push(c as Buffer);
      pipeQueue = Buffer.concat(chunks).toString('utf8').split('\n');
      if (pipeQueue.length && pipeQueue[pipeQueue.length - 1] === '') pipeQueue.pop();
    }
    return (pipeQueue.shift() ?? '').trim();
  };

  process.stdout.write(`\nbayze init — 多模型协作路由配置向导\n\n`);
  process.stdout.write(`将生成两个文件（目录 ${dir}）：\n`);
  process.stdout.write(`  config.yaml   工作流与供应商声明（只含 env: 引用，可公开分享）\n`);
  process.stdout.write(`  .env          API Key 本体（权限 600，不进 git）\n\n`);

  // ① 选供应商
  const keys = Object.keys(PROVIDER_PRESETS);
  process.stdout.write(`① 选择要启用的供应商（输入编号，逗号分隔，回车确认）：\n`);
  keys.forEach((k, i) => {
    const p = PROVIDER_PRESETS[k]!;
    process.stdout.write(`  ${i + 1}. ${p.label.padEnd(10)} ${p.baseUrl}  注册：${p.signupUrl}\n`);
  });
  const pick = await ask(`编号 (如 1,2,3)：`);
  const pickedIdx = pick.split(/[,\s]+/).map((s) => parseInt(s.trim(), 10) - 1).filter((n) => Number.isInteger(n) && n >= 0 && n < keys.length);
  const pickedKeys = [...new Set(pickedIdx)].map((n) => keys[n]!);
  if (pickedKeys.length === 0) return fail('至少选择一个供应商', 2);
  process.stdout.write(`\n已选：${pickedKeys.map((k) => PROVIDER_PRESETS[k]!.label).join('、')}\n\n`);

  // ② 逐个收集 Key
  const providers: Array<{ id: string; apiKey: string; envVar: string; models: string[]; baseUrl?: string }> = [];
  for (const k of pickedKeys) {
    const preset = PROVIDER_PRESETS[k]!;
    process.stdout.write(`② ${preset.label} API Key（注册：${preset.signupUrl}）：`);
    let apiKey = (await ask('')).trim();
    if (!apiKey) {
      process.stdout.write(`  ⚠ 未填写——该供应商将跳过（之后可手动补）\n\n`);
      continue;
    }
    providers.push({ id: k, apiKey, envVar: preset.envVar, models: preset.models });
    process.stdout.write(`\n`);
  }
  if (providers.length === 0) return fail('没有填写任何 Key，向导结束', 1);

  // ③ 预算
  const costStr = (await ask(`③ 单次运行预算上限（USD，直接回车默认 0.10）：`)).trim();
  const maxCostUsd = Number(costStr) > 0 ? Number(costStr) : 0.10;
  process.stdout.write(`\n`);

  const ans = {
    providers: providers.map((p) => ({ ...p, baseUrl: undefined })),
    defaultWorkflow: 'review_then_revise' as const,
    maxCostUsd,
    targetDir: dir,
  };

  // ④ 生成并落盘（防覆盖）
  const written = writeInitFiles(ans);
  if (!written.ok) return fail(written.error.message, 1);
  process.stdout.write(`\n✓ config.yaml  已生成: ${written.value.configPath}\n`);
  process.stdout.write(`✓ .env        已生成: ${written.value.envPath}（权限 600）\n`);

  // ⑤ 自动校验（fail-closed：不合格的配置不留着）
  const loaded = loadConfig(written.value.configPath);
  if (!loaded.ok) {
    process.stderr.write(`\n✗ 生成的配置未通过校验（这是 bayze 的 bug，请提 issue）:\n${formatConfigError(loaded.error)}\n`);
    return 1;
  }
  process.stdout.write(`✓ 配置校验通过（工作流：${Object.keys(loaded.value.workflows).join('、')}）\n`);

  // ⑥ .env 注入当前进程，供本次后续命令使用 + 输出 shell 持久化指引
  const envCount = loadDotEnv(written.value.envPath);
  process.stdout.write(`✓ API Key 已注入当前会话（${envCount} 个）\n\n`);
  process.stdout.write(`要让 Key 在新终端也生效，把下面这行加进 ~/.zshenv（或 ~/.bashrc）：\n`);
  process.stdout.write(`  set -a; source ${written.value.envPath}; set +a\n\n`);

  // ⑦ Cherry Studio 注册 JSON
  process.stdout.write(`=== 在 Cherry Studio 注册（设置 → MCP 服务器 → 添加）===\n`);
  process.stdout.write(renderCherryJson(ans) + `\n\n`);

  // ⑧ 立即测试
  process.stdout.write(`=== 立即测试 ===\n`);
  process.stdout.write(`  node dist/src/cli.js run --workflow quick_answer --config ${written.value.configPath} --input "你好"\n`);
  process.stdout.write(`  （或 bayze run --workflow quick_answer --input "你好"）\n\n`);
  return 0;
}

function defaultBayzeDir(): string {
  const home = process.env.HOME ?? '';
  return `${home}/.bayze`;
}

function fail(message: string, code: number): number {
  process.stderr.write(`${message}\n`);
  return code;
}
