import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync, closeSync, openSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { err, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';
import type { Usage } from '../domain/types.js';

export const JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const JOURNAL_MAX_BYTES = 10 * 1024 * 1024;

/** 摘要记录：绝不含 prompt、response 或密钥（基线 §8） */
export interface JournalStepSummary {
  name: string;
  providerId: string;
  modelId: string;
  /** 接入模式（基线 v0.4.1 §6） */
  mode?: 'byok' | 'bayze_api';
  status: string;
  durationMs: number;
  usage?: Usage;
  estimatedCost?: number;
}

export interface JournalRecord {
  v: 1;
  ts: string;
  runId: string;
  workflowId: string;
  status: string;
  stopReason: string;
  triggerReason?: string;
  durationMs: number;
  steps: JournalStepSummary[];
  warnings: string[];
}

export interface JournalOptions {
  retentionMs?: number;
  maxBytes?: number;
}

/**
 * 运行摘要 journal：本地 JSONL、按时间保留、按体积封顶（基线 §8）。
 * filePath 为 null 时为 Noop（--no-journal）。
 * 跨进程：append 单行写；重写（轮转）在 lockfile 保护下 tmp+rename。
 */
export class RunJournal {
  private readonly retentionMs: number;
  private readonly maxBytes: number;

  constructor(
    private readonly filePath: string | null,
    opts: JournalOptions = {},
  ) {
    this.retentionMs = opts.retentionMs ?? JOURNAL_RETENTION_MS;
    this.maxBytes = opts.maxBytes ?? JOURNAL_MAX_BYTES;
  }

  get enabled(): boolean {
    return this.filePath !== null;
  }

  get path(): string | null {
    return this.filePath;
  }

  append(rec: JournalRecord): Result<null, string> {
    if (!this.filePath) return ok(null);
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(rec)}\n`, 'utf8');
      this.maintain();
      return ok(null);
    } catch (e) {
      return err(`journal append failed: ${(e as Error).message}`);
    }
  }

  tail(n = 20): JournalRecord[] {
    if (!this.filePath || !existsSync(this.filePath)) return [];
    const lines = readFileSync(this.filePath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    const recs: JournalRecord[] = [];
    for (const line of lines.slice(-Math.max(1, n))) {
      try {
        recs.push(JSON.parse(line) as JournalRecord);
      } catch {
        /* 跳过损坏行 */
      }
    }
    return recs;
  }

  /** 按 runId 从最新往回查找（供 get_run_summary） */
  findByRunId(runId: string): JournalRecord | undefined {
    if (!this.filePath || !existsSync(this.filePath)) return undefined;
    const lines = readFileSync(this.filePath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const r = JSON.parse(line) as JournalRecord;
        if (r.runId === runId) return r;
      } catch {
        /* 跳过损坏行 */
      }
    }
    return undefined;
  }

  clear(): Result<null, string> {
    if (!this.filePath) return ok(null);
    try {
      for (const p of [this.filePath, `${this.filePath}.lock`, `${this.filePath}.tmp`]) {
        rmSync(p, { force: true });
      }
      return ok(null);
    } catch (e) {
      return err(`journal clear failed: ${(e as Error).message}`);
    }
  }

  /** 保留期清除 + 体积封顶（丢弃最旧）；lockfile 忙时跳过本次维护 */
  private maintain(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    const done = this.withLock(() => {
      const raw = readFileSync(this.filePath as string, 'utf8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      const cutoff = Date.now() - this.retentionMs;
      const kept: string[] = [];
      for (const line of lines) {
        const ts = parseTs(line);
        if (ts !== undefined && ts < cutoff) continue;
        kept.push(line);
      }
      let bytes = kept.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
      while (bytes > this.maxBytes && kept.length > 0) {
        const dropped = kept.shift() ?? '';
        bytes -= Buffer.byteLength(dropped) + 1;
      }
      const out = kept.length > 0 ? `${kept.join('\n')}\n` : '';
      if (out !== raw) {
        const tmp = `${this.filePath}.tmp`;
        writeFileSync(tmp, out, 'utf8');
        renameSync(tmp, this.filePath as string);
      }
    });
    void done;
  }

  private withLock<T>(fn: () => T): T | undefined {
    if (!this.filePath) return undefined;
    const lockPath = `${this.filePath}.lock`;
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, 'wx');
    } catch {
      return undefined; // 其他进程持有锁：跳过本次维护
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        /* best effort */
      }
    }
  }
}

function parseTs(line: string): number | undefined {
  try {
    const r = JSON.parse(line) as { ts?: string };
    return r.ts ? Date.parse(r.ts) : undefined;
  } catch {
    return undefined;
  }
}
