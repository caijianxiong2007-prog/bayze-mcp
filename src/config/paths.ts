import { join } from 'node:path';

/** 默认配置目录：遵循 OS 用户配置目录（基线 §8）；只读取，从不写入 */
export function defaultConfigDir(): string {
  switch (process.platform) {
    case 'darwin':
      return join(process.env.HOME ?? '', 'Library', 'Application Support', 'bayze');
    case 'win32':
      return join(process.env.APPDATA ?? '', 'bayze');
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config'), 'bayze');
  }
}

export function defaultConfigPath(): string {
  return join(defaultConfigDir(), 'config.yaml');
}

/** journal 与配置同目录（基线 §8：摘要 JSONL、7 天/10MB、可清除） */
export function defaultJournalPath(): string {
  return join(defaultConfigDir(), 'journal.jsonl');
}
