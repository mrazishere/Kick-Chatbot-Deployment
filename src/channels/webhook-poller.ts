import * as fs from 'fs';
import * as path from 'path';
import {
  FollowEvent,
  KicksGiftedEvent,
  LivestreamStatusEvent,
  ModerationBannedEvent,
  QueueMeta,
  RewardRedemptionEvent,
  SubscriptionEvent,
  SubscriptionGiftsEvent
} from '../types';

const POLL_MS = 200;
const MAX_SEEN = 500;

/**
 * How old a queued event may be and still be acted on.
 *
 * The enrollment service queues events whether or not this bot is running, so a
 * bot started after being stopped for hours would otherwise answer stale chat,
 * run stale /timeout commands, and act on redemptions the streamer has already
 * resolved by hand. Ban events only ever clear state, so they apply at any age.
 * Points bonuses are owed however late they're processed, within reason.
 */
const MAX_CHAT_AGE_MS = 2 * 60 * 1000;
const MAX_REDEMPTION_AGE_MS = 10 * 60 * 1000;
const MAX_BONUS_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** What the bot does with each event type. Only `chat` is required. */
export interface WebhookHandlers {
  chat: (data: Record<string, unknown>) => void;
  redemption?: (event: RewardRedemptionEvent) => void;
  ban?: (event: ModerationBannedEvent) => void;
  follow?: (event: FollowEvent, meta: QueueMeta) => void;
  subscriptionNew?: (event: SubscriptionEvent, meta: QueueMeta) => void;
  subscriptionRenewal?: (event: SubscriptionEvent, meta: QueueMeta) => void;
  subscriptionGifts?: (event: SubscriptionGiftsEvent, meta: QueueMeta) => void;
  kicksGifted?: (event: KicksGiftedEvent, meta: QueueMeta) => void;
  livestreamStatus?: (event: LivestreamStatusEvent, meta: QueueMeta) => void;
}

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
  private handlers: WebhookHandlers;
  private queuePath: string;
  /** Raw gifted-subs payloads, next to the queue directory (data/gift-samples.jsonl). */
  private giftSamplePath: string;
  private interval: NodeJS.Timeout | null = null;
  private seenIds: string[] = [];
  /** Event names already reported as unhandled, so each is logged once. */
  private unhandled = new Set<string>();

  /** `queueDir` overrides data/webhook-events (selftest). */
  constructor(channelName: string, handlers: WebhookHandlers, queueDir?: string) {
    this.channelName = channelName;
    this.handlers = handlers;
    const dir = queueDir ?? path.join(process.cwd(), 'data', 'webhook-events');
    this.queuePath = path.join(dir, `${channelName}.jsonl`);
    this.giftSamplePath = path.join(path.dirname(dir), 'gift-samples.jsonl');
  }

  /**
   * Keep every gifted-subs payload as Kick sent it (the enrollment service queues
   * it unchanged). Whether Kick still names the gifter when `is_anonymous` is true
   * decides how anonymous gifts can be credited, and only a real payload says.
   */
  private recordGiftSample(event: Record<string, unknown>, meta: QueueMeta): void {
    console.log(`[WEBHOOK] gifted subs, gifter as sent: ${JSON.stringify(event.gifter ?? null).slice(0, 300)}`);
    try {
      fs.appendFileSync(
        this.giftSamplePath,
        JSON.stringify({ receivedAt: new Date().toISOString(), channelName: this.channelName, messageId: meta.messageId, payload: event }) + '\n',
        'utf8'
      );
    } catch (err) {
      console.error(`[WEBHOOK] Could not record a gift sample: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  start(): void {
    if (this.interval) return;
    fs.mkdirSync(path.dirname(this.queuePath), { recursive: true });
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

  /** Process the queue once. Public for the selftest; the interval calls it. */
  poll(): void {
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

        // Newer queue lines are wrapped as { __event, receivedAt, messageId?, payload }.
        // Lines written by an older enrollment build are bare chat payloads.
        const wrapped = typeof parsed['__event'] === 'string';
        const eventName = wrapped ? (parsed['__event'] as string) : 'chat.message.sent';
        const event = (wrapped ? parsed['payload'] : parsed) as Record<string, unknown>;
        if (!event) continue;
        const age = queuedAgeMs(wrapped ? parsed['receivedAt'] : undefined);
        const meta: QueueMeta = {
          ageMs: age,
          messageId: typeof parsed['messageId'] === 'string' ? (parsed['messageId'] as string) : undefined
        };

        switch (eventName) {
          case 'chat.message.sent': {
            if (age !== null && age > MAX_CHAT_AGE_MS) {
              staleChat++;
              break;
            }
            const msgId = event.message_id as string | undefined;
            if (msgId && this.seenIds.includes(msgId)) break;
            this.markSeen(msgId);
            console.log(`[WEBHOOK] chat from ${(event.sender as Record<string, unknown>)?.username}: ${String(event.content).slice(0, 80)}`);
            this.handlers.chat(toHandleChatFormat(event));
            break;
          }

          case 'moderation.banned':
            this.handlers.ban?.(event as unknown as ModerationBannedEvent);
            break;

          case 'channel.reward.redemption.updated': {
            const redemption = event as unknown as RewardRedemptionEvent;
            if (age !== null && age > MAX_REDEMPTION_AGE_MS) {
              console.log(
                `[WEBHOOK] Skipping reward "${redemption.reward?.title}" by ${redemption.redeemer?.username} (${redemption.status}) — ` +
                `queued ${Math.round(age / 60_000)} min ago while the bot was not running; left for the streamer to resolve`
              );
              break;
            }
            console.log(`[WEBHOOK] reward "${redemption.reward?.title}" redeemed by ${redemption.redeemer?.username} (${redemption.status})`);
            this.handlers.redemption?.(redemption);
            break;
          }

          case 'channel.followed':
          case 'channel.subscription.new':
          case 'channel.subscription.renewal':
          case 'channel.subscription.gifts':
          case 'kicks.gifted': {
            if (eventName === 'channel.subscription.gifts') this.recordGiftSample(event, meta);
            if (age !== null && age > MAX_BONUS_AGE_MS) {
              console.log(`[WEBHOOK] Skipping ${eventName} queued ${Math.round(age / 3_600_000)} h ago`);
              break;
            }
            if (eventName === 'channel.followed') this.handlers.follow?.(event as unknown as FollowEvent, meta);
            else if (eventName === 'channel.subscription.new') this.handlers.subscriptionNew?.(event as unknown as SubscriptionEvent, meta);
            else if (eventName === 'channel.subscription.renewal') this.handlers.subscriptionRenewal?.(event as unknown as SubscriptionEvent, meta);
            else if (eventName === 'channel.subscription.gifts') this.handlers.subscriptionGifts?.(event as unknown as SubscriptionGiftsEvent, meta);
            else this.handlers.kicksGifted?.(event as unknown as KicksGiftedEvent, meta);
            break;
          }

          case 'livestream.status.updated':
            this.handlers.livestreamStatus?.(event as unknown as LivestreamStatusEvent, meta);
            break;

          default:
            // Never treat an unknown event as chat: it would arrive as a malformed
            // message, and whatever it carried would be lost.
            if (!this.unhandled.has(eventName)) {
              this.unhandled.add(eventName);
              console.log(`[WEBHOOK] Ignoring unhandled event type ${eventName}`);
            }
        }
      } catch { /* skip malformed line */ }
    }

    if (staleChat > 0) {
      console.log(`[WEBHOOK] Skipped ${staleChat} stale chat message(s) queued while the bot was not running`);
    }
    try { fs.unlinkSync(procPath); } catch { /* ignore */ }
  }
}
