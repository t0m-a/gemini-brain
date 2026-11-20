/**
 * Lightweight test stubs for Cloudflare Workers built-in base classes (`cloudflare:workers`)
 * so Vitest can test BrainMemoryDO, federation.ts, and index.ts directly in Node.
 */

export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async alarm(_alarmInfo?: { retryCount: number; isRetry: boolean }): Promise<void> {}
}

export class WorkerEntrypoint<Env = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
