import * as fs from 'fs';
import * as path from 'path';
import { ModerationBannedEvent, RewardRedemptionEvent } from '../types';

const QUEUE_DIR = path.join(process.cwd(), 'data', 'webhook-events');
const POLL_MS = 200;
const MAX_SEEN = 500;

// Maps Kick webhook chat.message.sent payload → handleChatMessage data format
function toHandleChatFormat(event: Record<string, unknown>): Record<string, unknown> {
  const sender = event.sender as Record<string, unknown> | undefined;
  const broadcaster = event.broadcaster as Record<string, unknown> | undefined;
  return {
    id: event.message_id,
    chatroom_id: broadcaster?.user_id,
    content: event.content,
    created_at: event.created_at,
    sender: {
      id: sender?.user_id,
      username: sender?.username,
      slug: sender?.slug,
      identity: (sender?.identity as Record<string, unknown>) ?? { badges: [] }
    }
  };
}

export class WebhookPoller {
  private channelName: string;
  private onMessage: (data: Record<string, unknown>) => void;
  private onRedemption: ((event: RewardRedemptionEvent) => void) | null;
  private onBan: ((event: ModerationBannedEvent) => void) | null;
  private queuePath: string;
  private interval: NodeJS.Timeout | null = null;
  private seenIds: string[] = [];

  constructor(
    channelName: string,
    onMessage: (data: Record<string, unknown>) => void,
    onRedemption?: (event: RewardRedemptionEvent) => void,
    onBan?: (event: ModerationBannedEvent) => void
  ) {
    this.channelName = channelName;
    this.onMessage = onMessage;
    this.onRedemption = onRedemption ?? null;
    this.onBan = onBan ?? null;
    this.queuePath = path.join(QUEUE_DIR, `${channelName}.jsonl`);
  }

  start(): void {
    if (this.interval) return;
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    this.interval = setInterval(() => this.poll(), POLL_MS);
    console.log('[WEBHOOK] Queue poller started');
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // Call this when a Pusher message is processed — prevents duplicate processing
  markSeen(messageId: string | undefined): void {
    if (!messageId) return;
    this.seenIds.push(messageId);
    if (this.seenIds.length > MAX_SEEN) this.seenIds.shift();
  }

  private poll(): void {
    if (!fs.existsSync(this.queuePath)) return;
    let content: string;
    try { content = fs.readFileSync(this.queuePath, 'utf8'); } catch { return; }
    if (!content.trim()) return;

    // Atomically consume: rename → process → delete
    const tmpPath = this.queuePath + '.proc';
    try { fs.renameSync(this.queuePath, tmpPath); } catch { return; }

    const lines = content.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;

        // Newer queue lines are wrapped as { __event, payload }. Lines written
        // by an older enrollment build are bare chat payloads.
        const wrapped = typeof parsed['__event'] === 'string';
        const eventName = wrapped ? (parsed['__event'] as string) : 'chat.message.sent';
        const event = (wrapped ? parsed['payload'] : parsed) as Record<string, unknown>;
        if (!event) continue;

        if (eventName === 'moderation.banned') {
          this.onBan?.(event as unknown as ModerationBannedEvent);
          continue;
        }

        if (eventName === 'channel.reward.redemption.updated') {
          const redemption = event as unknown as RewardRedemptionEvent;
          console.log(`[WEBHOOK] reward "${redemption.reward?.title}" redeemed by ${redemption.redeemer?.username} (${redemption.status})`);
          this.onRedemption?.(redemption);
          continue;
        }

        const msgId = event.message_id as string | undefined;
        if (msgId && this.seenIds.includes(msgId)) continue;
        this.markSeen(msgId);
        console.log(`[WEBHOOK] chat from ${(event.sender as Record<string,unknown>)?.username}: ${String(event.content).slice(0, 80)}`);
        this.onMessage(toHandleChatFormat(event));
      } catch { /* skip malformed line */ }
    }

    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}
