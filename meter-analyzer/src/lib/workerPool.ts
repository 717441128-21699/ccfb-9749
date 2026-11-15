// Worker 池：固定数量 Worker 并行处理分块任务，FIFO 调度
import type { WorkerRequest, WorkerResponse } from './worker.ts';

interface Job {
  task: WorkerRequest;
  resolve: (r: WorkerResponse) => void;
  reject: (e: Error) => void;
}

export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private jobs: Job[] = [];
  private pending = new Map<Worker, Job>();

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(w, e.data);
      w.onerror = (e) => this.onError(w, new Error(e.message));
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  private onMessage(w: Worker, res: WorkerResponse): void {
    const job = this.pending.get(w);
    this.pending.delete(w);
    this.idle.push(w);
    if (job) {
      if (res.kind === 'error') job.reject(new Error(res.error));
      else job.resolve(res);
    }
    this.pump();
  }

  private onError(w: Worker, err: Error): void {
    const job = this.pending.get(w);
    this.pending.delete(w);
    if (!this.idle.includes(w)) this.idle.push(w);
    if (job) job.reject(err);
    this.pump();
  }

  submit(task: WorkerRequest): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      this.jobs.push({ task, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.idle.length && this.jobs.length) {
      const w = this.idle.shift()!;
      const job = this.jobs.shift()!;
      this.pending.set(w, job);
      w.postMessage(job.task);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  async dispose(): Promise<void> {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    this.jobs = [];
    this.pending.clear();
  }
}

export function recommendedWorkerCount(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(2, Math.min(14, cores - 2));
}
