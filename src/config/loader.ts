import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { err, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import { configSchema } from './schema.js';
import type { BayzeConfig } from './schema.js';

export interface ConfigIssue {
  path: string;
  message: string;
}

export type ConfigLoadError =
  | { kind: 'not_found'; path: string; message: string }
  | { kind: 'read_failed'; path: string; message: string }
  | { kind: 'parse_failed'; path: string; message: string }
  | { kind: 'invalid'; path: string; issues: ConfigIssue[] };

/** 读取并校验配置；只读，从不写入或创建文件（基线 §8） */
export function loadConfig(path: string): Result<BayzeConfig, ConfigLoadError> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const message =
      code === 'ENOENT'
        ? 'config file not found (create one, or pass --config <path>)'
        : `cannot read config file: ${code ?? String(e)}`;
    return err(code === 'ENOENT' ? { kind: 'not_found', path, message } : { kind: 'read_failed', path, message });
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return err({ kind: 'parse_failed', path, message: `YAML parse error: ${(e as Error).message}` });
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: ConfigIssue[] = parsed.error.issues.map((i) => ({
      path: i.path.length ? i.path.join('.') : '<root>',
      message: i.message,
    }));
    return err({ kind: 'invalid', path, issues });
  }
  return ok(parsed.data);
}

export function formatConfigError(e: ConfigLoadError): string {
  if (e.kind === 'invalid') {
    return [`config check failed (invalid): ${e.path}`, ...e.issues.map((i) => `  ${i.path}: ${i.message}`)].join('\n');
  }
  return `config check failed (${e.kind}): ${e.path}\n  ${e.message}`;
}
