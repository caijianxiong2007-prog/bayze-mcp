import { err } from '../../domain/errors.js';
import type { Result } from '../../domain/errors.js';
import { WorkflowOrchestrator } from '../../application/workflows/orchestrator.js';
import type { RunSetupError, StepProgress } from '../../application/workflows/orchestrator.js';
import { RunScheduler } from '../../application/workflows/scheduler.js';
import type { RunRequest, RunResult } from '../../domain/types.js';
import type { BayzeConfig } from '../../config/schema.js';
import type { RunJournal } from '../../journal/journal.js';

export type McpRunError = RunSetupError | { code: 'overloaded'; message: string };

export interface McpRunOptions {
  signal?: AbortSignal;
  onProgress?: (p: StepProgress) => void;
}

/**
 * 进程内运行管理（基线 §3）：
 * - 并发/队列限制来自 runtime 配置，超出立即 `overloaded`
 * - 登记每个在途 run 的 AbortController；stdio 关闭时 shutdown() 统一中止
 */
export class McpApp {
  readonly orchestrator: WorkflowOrchestrator;
  private readonly scheduler: RunScheduler;
  private readonly controllers = new Set<AbortController>();

  constructor(
    readonly cfg: BayzeConfig,
    readonly journal: RunJournal,
  ) {
    this.orchestrator = new WorkflowOrchestrator(cfg);
    this.scheduler = new RunScheduler(cfg.runtime.max_concurrency, cfg.runtime.max_queue_size);
  }

  get activeRuns(): number {
    return this.scheduler.inFlight;
  }

  async run(req: RunRequest, opts: McpRunOptions = {}): Promise<Result<RunResult, McpRunError>> {
    const inner = new AbortController();
    this.controllers.add(inner);
    const outer = opts.signal;
    const propagate = () => inner.abort();
    if (outer) {
      if (outer.aborted) inner.abort();
      outer.addEventListener('abort', propagate, { once: true });
    }
    const submitted = this.scheduler.submit(() =>
      this.orchestrator.run(req, {
        signal: inner.signal,
        journal: this.journal,
        onProgress: opts.onProgress,
      }),
    );
    if (!submitted.ok) {
      if (outer) outer.removeEventListener('abort', propagate);
      this.controllers.delete(inner);
      return err({ code: 'overloaded', message: submitted.error.message });
    }
    try {
      return await submitted.value;
    } finally {
      if (outer) outer.removeEventListener('abort', propagate);
      this.controllers.delete(inner);
    }
  }

  /** 中止全部在途 run（stdio 关闭时调用；基线 §3：5 秒内停止发出新供应商请求） */
  shutdown(): void {
    for (const ac of this.controllers) ac.abort();
    this.controllers.clear();
  }
}
