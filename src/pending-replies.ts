import { tr } from './i18n.ts';
export interface ReplyMetadata { control?: boolean }
export interface PendingReply extends ReplyMetadata {
  resolve(data: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}
// One owner for replies and their timers; late replies are harmless.
export class PendingReplies {
  readonly pending = new Map<number, PendingReply>();
  wait(request: number, timeout = 12000, message = tr('O jogo demorou a responder. Tente de novo.'), metadata: ReplyMetadata = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle(request, new Error(message)), timeout);
      this.pending.set(request, { ...metadata, resolve, reject, timer });
    });
  }
  settle(request: number, error?: unknown, data?: unknown): void {
    const callback = this.pending.get(request); if (!callback) return;
    clearTimeout(callback.timer); this.pending.delete(request);
    if (error) callback.reject(error); else callback.resolve(data);
  }
  rejectAll(error: unknown): void { for (const request of this.pending.keys()) this.settle(request, error); }
}
