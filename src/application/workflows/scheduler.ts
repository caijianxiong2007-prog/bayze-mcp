import { err, ok } from '../../domain/errors.js';
import type { Result } from '../../domain/errors.js';

/**
 * 进程内 run 调度（基线 §3）：并发满且队列满时立即拒绝 `overloaded`，不无限积压。
 */
export class RunScheduler {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
  ) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.queue.length;
  }

  submit<T>(task: () => Promise<T>): Result<Promise<T>, { code: 'overloaded'; message: string }> {
    if (this.active < this.maxConcurrent) {
      return ok(this.start(task));
    }
    if (this.queue.length >= this.maxQueue) {
      return err({
        code: 'overloaded',
        message: `run rejected: ${this.active} active and queue full (${this.maxQueue})`,
      });
    }
    return ok(
      new Promise<T>((resolve, reject) => {
        this.queue.push(() => {
          this.start(task).then(resolve, reject);
        });
      }),
    );
  }

  private start<T>(task: () => Promise<T>): Promise<T> {
    this.active++;
    return task().finally(() => {
      this.active--;
      this.queue.shift()?.();
    });
  }
}
