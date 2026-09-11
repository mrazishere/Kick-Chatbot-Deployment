import * as fs from 'fs';
import * as path from 'path';
import { ModerationBannedEvent, RewardRedemptionEvent } from '../types';

const QUEUE_DIR = path.join(process.cwd(), 'data', 'webhook-events');
const POLL_MS = 200;
const MAX_SEEN = 500;

/**
 * How old a queued event may be and still be acted on.
 *
 * The enrollment service queues events whether or not this bot is running, so a
 * bot started after being stopped for hours would otherwise answer stale chat,
 * run stale /timeout commands, and act on redemptions the streamer has already
 * resolved by hand. Ban events only ever clear state, so they apply at any age.
 */
const MAX_CHAT_AGE_MS = 2 * 60 * 1000;
const MAX_REDEMPTION_AGE_MS = 10 * 60 * 1000;

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

/**
 * Milliseconds since the enrollment service queued a line, or null for lines
 * from an older build that didn't stamp them. Only that stamp is trusted: Kick's
 * own timestamps come in more than one format, and misreading one as local time
 * would throw away every message.
 */
function queuedAgeMs(receivedAt: unknown): number | null {
  return typeof receivedAt === 'number' && Number.isFinite(receivedAt) ? Date.now() - receivedAt : null;
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
  /** Record a message as handled. Returns false when it already was, so the caller can skip it. */
  markSeen(messageId: string | undefined): boolean {
    if (!messageId) return true;
    if (this.seenIds.includes(messageId)) return false;
    this.seenIds.push(messageId);
    if (this.seenIds.length > MAX_SEEN) this.seenIds.shift();
    return true;
  }

  private poll(): void {
    const procPath = this.queuePath + '.proc';

    // A leftover .proc means the last run died mid-batch; finish it before claiming more.
    if (!fs.existsSync(procPath)) {
      if (!fs.existsSync(this.queuePath)) return;
      // Claim the queue BEFORE reading it. Reading first and renaming second lost
      // whatever the enrollment service appended in between, redemptions included.
      try { fs.renameSync(this.queuePath, procPath); } catch { return; }
    }

    let content: string;
    try { content = fs.readFileSync(procPath, 'utf8'); } catch { return; }

    let staleChat = 0;
    const lines = content.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;

        // Newer queue lines are wrapped as { __event, receivedAt, payload }. Lines
        // written by an older enrollment build are bare chat payloads.
        const wrapped = typeof parsed['__event'] === 'string';
        const eventName = wrapped ? (parsed['__event'] as string) : 'chat.message.sent';
        const event = (wrapped ? parsed['payload'] : parsed) as Record<string, unknown>;
        if (!event) continue;
        const age = queuedAgeMs(wrapped ? parsed['receivedAt'] : undefined);

        if (eventName === 'moderation.banned') {
          this.onBan?.(event as unknown as ModerationBannedEvent);
          continue;
        }

        if (eventName === 'channel.reward.redemption.updated') {
          const redemption = event as unknown as RewardRedemptionEvent;
          if (age !== null && age > MAX_REDEMPTION_AGE_MS) {
            console.log(
              `[WEBHOOK] Skipping reward "${redemption.reward?.title}" by ${redemption.redeemer?.username} (${redemption.status}) — ` +
              `queued ${Math.round(age / 60_000)} min ago while the bot was not running; left for the streamer to resolve`
            );
            continue;
          }
          console.log(`[WEBHOOK] reward "${redemption.reward?.title}" redeemed by ${redemption.redeemer?.username} (${redemption.status})`);
          this.onRedemption?.(redemption);
          continue;
        }

        if (age !== null && age > MAX_CHAT_AGE_MS) {
          staleChat++;
          continue;
        }

        const msgId = event.message_id as string | undefined;
        if (msgId && this.seenIds.includes(msgId)) continue;
        this.markSeen(msgId);
        console.log(`[WEBHOOK] chat from ${(event.sender as Record<string,unknown>)?.username}: ${String(event.content).slice(0, 80)}`);
        this.onMessage(toHandleChatFormat(event));
      } catch { /* skip malformed line */ }
    }

    if (staleChat > 0) {
      console.log(`[WEBHOOK] Skipped ${staleChat} stale chat message(s) queued while the bot was not running`);
    }
    try { fs.unlinkSync(procPath); } catch { /* ignore */ }
  }
}
