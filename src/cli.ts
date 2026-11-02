#!/usr/bin/env node
// bayze CLI（阶段 1）：配置校验与路径查询；只读，不写任何文件
import { formatConfigError, loadConfig } from './config/loader.js';
import { defaultConfigPath } from './config/paths.js';
import { CredentialStore } from './credentials/store.js';

const USAGE = `bayze <command> [options]

commands:
  config check [--config <path>] [--strict]   validate config (read-only)
  config path                                 print the default config path

options:
  --config <path>   config file to check (default: OS user config dir, see "config path")
  --strict          additionally verify that every env: credential ref resolves
`;

function fail(message: string, code: 1 | 2): number {
  process.stderr.write(`${message}\n`);
  return code;
}

function main(argv: string[]): number {
  const [cmd, sub, ...rest] = argv;
  if (cmd !== 'config') return fail(USAGE, 2);
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

process.exitCode = main(process.argv.slice(2));
