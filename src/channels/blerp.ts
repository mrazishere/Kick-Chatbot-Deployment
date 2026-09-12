/**
 * Blerp: turning a Kick clip into a sound on the streamer's soundboard.
 *
 * Blerp has no public API. Everything here was read off their own clients —
 * the production GraphQL endpoint at api.blerp.com with introspection disabled,
 * so the operations below come from the shipped Chrome extension (v1.2.15) and
 * were each confirmed against the live schema before use. Their public GitHub
 * repos are years stale and describe mutations that no longer exist; do not
 * trust them over the extension bundle.
 *
 * The flow !blerp drives:
 *
 *   1. biteCreateByYouTube — despite the name this is a generic URL importer.
 *      Handing it a kick.com clip URL works: Blerp fetches and decodes the
 *      clip itself, so the bot never downloads or transcodes anything.
 *   2. createOneBiteSuggestion — offers the new sound to a streamer's board.
 *      It lands in their suggestion queue as PENDING; the streamer approves or
 *      rejects it in their own Blerp dashboard. Nothing reaches a stream
 *      without them saying yes.
 *
 * Auth is a JWT with a 20-day life, kept in .blerp-session.json (the same
 * shape as the Kick .session.json). Renewal is tried in order:
 *
 *   1. the stored refresh token, which Blerp rotates on every use
 *   2. BLERP_EMAIL / BLERP_PASSWORD, which also mints a fresh refresh token
 *
 * A password sign-in therefore seeds the refresh chain as a side effect, so
 * the credentials are the safety net rather than the routine path. With
 * neither available the watchdog warns over Telegram while there is still
 * time to act (see blerp-session.ts).
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const API = 'https://api.blerp.com/graphql';
const TIMEOUT_MS = 30_000;
/** Blerp rejects anything longer; Kick's 30s clips land right on the edge. */
export const MAX_BLERP_SECONDS = 30;
/** Their title field is generous but chat is not. */
export const MAX_TITLE = 100;

export interface BlerpSession {
  jwt?: string;
  refreshToken?: string;
  username?: string;
  savedAt?: number;
}

export interface CreatedBlerp {
  id: string;
  title: string;
  url: string;
}

export interface Suggestion {
  id: string;
  approvalState: string | null;
}

function sessionPath(): string {
  return path.join(process.cwd(), '.blerp-session.json');
}

function readSession(): BlerpSession {
  for (const file of [sessionPath(), path.join(__dirname, '..', '.blerp-session.json')]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as BlerpSession;
      if (typeof raw.jwt === 'string' && raw.jwt.trim()) return raw;
    } catch { /* try the next location */ }
  }
  return {};
}

export function writeSession(next: BlerpSession): void {
  const payload = JSON.stringify({ ...next, savedAt: Date.now() }, null, 2);
  try { fs.writeFileSync(sessionPath(), payload, { mode: 0o600 }); } catch { /* best effort */ }
}

/** Whether a refresh token is stored, i.e. whether renewal can happen unattended. */
export function hasRefreshToken(): boolean {
  return !!(readSession().refreshToken || '').trim();
}

/** Order: BLERP_JWT in the environment, then .blerp-session.json. */
export function blerpJwt(): string | null {
  const fromEnv = (process.env.BLERP_JWT || '').trim();
  if (fromEnv) return fromEnv;
  const jwt = (readSession().jwt || '').trim();
  return jwt || null;
}

/**
 * Epoch ms this JWT stops being accepted, or null when it cannot be read.
 * The payload is inspected rather than trusted blindly — a malformed token
 * should read as "expired" and trigger a renewal, not throw mid-command.
 */
export function jwtExpiresAt(token = blerpJwt()): number | null {
  if (!token) return null;
  try {
    const seg = token.split('.')[1];
    if (!seg) return null;
    const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Renew this far ahead of expiry rather than waiting for the cliff. */
export const RENEW_AHEAD_MS = 3 * 24 * 60 * 60_000;

/** True when the token dies inside `ms`. Unknown expiry counts as fine. */
export function expiringWithin(ms: number, token = blerpJwt()): boolean {
  const exp = jwtExpiresAt(token);
  return exp === null ? false : exp - Date.now() < ms;
}

export function jwtIsLive(token = blerpJwt()): boolean {
  const exp = jwtExpiresAt(token);
  // No readable expiry: let the call itself decide rather than blocking it here.
  return exp === null ? !!token : exp > Date.now();
}

function detail(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const body = err.response?.data as { errors?: Array<{ message?: string }> } | undefined;
    const first = body?.errors?.[0]?.message;
    if (first) return String(first);
    return err.response ? `HTTP ${err.response.status}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * One GraphQL call. Blerp answers HTTP 200 with an `errors` array rather than
 * an error status, so the body is what decides success.
 */
async function gql<T>(query: string, variables: Record<string, unknown>, token: string): Promise<T> {
  const res = await axios.post(
    API,
    { query, variables },
    {
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
      timeout: TIMEOUT_MS
    }
  );
  const body = res.data as { data?: T; errors?: Array<{ message?: string; extensions?: { code?: string } }> };
  if (body.errors?.length) {
    const first = body.errors[0];
    const code = first?.extensions?.code;
    throw new Error(code === 'UNAUTHENTICATED' ? 'blerp session expired' : String(first?.message || 'Blerp rejected the request'));
  }
  if (!body.data) throw new Error('Blerp returned no data');
  return body.data;
}

/** The signed-in account, used to prove a token still works. */
export async function signedInAs(token = blerpJwt()): Promise<string | null> {
  if (!token) return null;
  try {
    const d = await gql<{ web: { userSignedIn: { username?: string } | null } }>(
      'query{web{userSignedIn{_id username}}}', {}, token
    );
    return d.web.userSignedIn?.username ?? null;
  } catch {
    return null;
  }
}

/**
 * Ask Blerp for a refresh token using nothing but the current JWT.
 *
 * This is how their browser extension bootstraps itself after a website login,
 * and it is the only way to obtain a refresh token for an account that signs in
 * through Kick OAuth and therefore has no password.
 *
 * It works once per login session — a second call answers "Already completed
 * login" — so it is fired automatically whenever a JWT is present without a
 * refresh token. Waste it and the account has to be logged in again.
 */
export async function mintRefreshToken(token = blerpJwt()): Promise<string | null> {
  if (!token) return null;
  try {
    const d = await gql<{ web: { completeLogin: { accessToken?: string; refreshToken?: string } | null } }>(
      'mutation{web{completeLogin{accessToken refreshToken}}}', {}, token
    );
    const out = d.web.completeLogin;
    if (!out?.refreshToken) return null;
    // Save before returning: a caller that logs instead of storing would burn
    // the single use for nothing.
    writeSession({ ...readSession(), jwt: out.accessToken || token, refreshToken: out.refreshToken });
    return out.refreshToken;
  } catch {
    // "Already completed login" lands here; the stored token, if any, still works.
    return null;
  }
}

/**
 * Spend the stored refresh token for a new JWT. Blerp rotates the refresh
 * token on every use, so the replacement is saved or the chain breaks.
 *
 * Their web client keeps this token httpOnly, which is why it cannot simply be
 * copied out of a browser — the first one has to come from a password sign-in.
 */
export async function refreshJwt(): Promise<string | null> {
  const stored = (readSession().refreshToken || '').trim();
  if (!stored) return null;
  try {
    const res = await axios.post(
      API,
      {
        query: `mutation($r:String!){web{userRefreshToken(record:{refreshToken:$r}){jwt refreshToken user{_id username}}}}`,
        variables: { r: stored }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS }
    );
    const body = res.data as {
      data?: { web?: { userRefreshToken?: { jwt?: string; refreshToken?: string; user?: { username?: string } } } };
      errors?: Array<{ message?: string }>;
    };
    if (body.errors?.length) return null;
    const out = body.data?.web?.userRefreshToken;
    if (!out?.jwt) return null;
    writeSession({
      ...readSession(),
      jwt: out.jwt,
      // Keep the old token if none came back rather than losing the chain.
      refreshToken: out.refreshToken || stored,
      username: out.user?.username
    });
    return out.jwt;
  } catch {
    return null;
  }
}

/**
 * Sign in with credentials. Slower and heavier than a refresh, but it is what
 * mints the first refresh token and what recovers once the chain is broken.
 */
export async function signIn(): Promise<string | null> {
  const usernameOrEmail = (process.env.BLERP_EMAIL || '').trim();
  const password = process.env.BLERP_PASSWORD || '';
  if (!usernameOrEmail || !password) return null;
  try {
    const res = await axios.post(
      API,
      {
        query: `query($u:String,$p:Password!){web{userSignInEmail(record:{usernameOrEmail:$u,password:$p}){jwt refreshToken user{_id username}}}}`,
        variables: { u: usernameOrEmail, p: password }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS }
    );
    const body = res.data as {
      data?: { web?: { userSignInEmail?: { jwt?: string; refreshToken?: string; user?: { username?: string } } } };
      errors?: Array<{ message?: string }>;
    };
    if (body.errors?.length) return null;
    const out = body.data?.web?.userSignInEmail;
    if (!out?.jwt) return null;
    writeSession({ ...readSession(), jwt: out.jwt, refreshToken: out.refreshToken, username: out.user?.username });
    return out.jwt;
  } catch {
    return null;
  }
}

/**
 * A usable token: the stored one while it lives, otherwise a fresh sign-in.
 * Returns null when the bot cannot authenticate and a human has to paste one.
 */
export async function usableJwt(): Promise<string | null> {
  const current = blerpJwt();
  // A live JWT with no refresh token is one login away from being stranded:
  // seed the chain now, while there is still a session to seed it from.
  if (current && jwtIsLive(current) && !(readSession().refreshToken || '').trim()) {
    await mintRefreshToken(current);
  }
  // Renew a little before the deadline: a token that dies mid-command reads to
  // chat as a broken feature, and renewing early costs one extra call a month.
  if (current && jwtIsLive(current) && !expiringWithin(RENEW_AHEAD_MS, current)) return current;
  return (await refreshJwt()) ?? (await signIn()) ?? (current && jwtIsLive(current) ? current : null);
}

/**
 * The Blerp account behind a Kick channel, when one is linked.
 *
 * Worth knowing before trusting this: a streamer can hold more than one Blerp
 * account, and the one carrying the Kick username is not necessarily the one
 * they stream with — sukasblood's Kick name sits on a dormant account while he
 * runs a different one. Prefer an explicit blerpStreamerId in the channel
 * config and keep this for discovery.
 */
export async function streamerIdForKickChannel(kickUsername: string, token: string): Promise<string | null> {
  try {
    const d = await gql<{ soundEmotes: { currentStreamerPage: { streamerBlerpUser: { _id?: string } | null } | null } }>(
      'query($k:String){soundEmotes{currentStreamerPage(kickUsername:$k){streamerBlerpUser{_id username}}}}',
      { k: kickUsername },
      token
    );
    return d.soundEmotes.currentStreamerPage?.streamerBlerpUser?._id ?? null;
  } catch {
    return null;
  }
}

/** Whether a streamer is currently taking suggestions at all. */
export async function acceptsSuggestions(streamerId: string, token: string): Promise<boolean | null> {
  try {
    const d = await gql<{ soundEmotes: { currentStreamerPage: { streamerBlerpUser: { suggestionsEnabled?: boolean } | null } | null } }>(
      'query($id:MongoID){soundEmotes{currentStreamerPage(userId:$id){streamerBlerpUser{_id suggestionsEnabled}}}}',
      { id: streamerId },
      token
    );
    const on = d.soundEmotes.currentStreamerPage?.streamerBlerpUser?.suggestionsEnabled;
    return typeof on === 'boolean' ? on : null;
  } catch {
    return null;
  }
}

/** Chat text is not a title: strip control characters and clamp the length. */
export function cleanTitle(raw: string, fallback: string): string {
  const cleaned = (raw || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chosen = cleaned || fallback;
  return chosen.length > MAX_TITLE ? `${chosen.slice(0, MAX_TITLE - 1).trimEnd()}…` : chosen;
}

/**
 * Import a URL as a new sound. Blerp fetches the media itself; `durationMs`
 * is how much of it to keep, in milliseconds (their field is named `duration`
 * but is not seconds — getting this wrong yields a silent clip).
 */
export async function createBlerpFromUrl(args: {
  url: string;
  title: string;
  token: string;
  seconds?: number;
  keywords?: string[];
  visibility?: 'PUBLIC' | 'PRIVATE';
}): Promise<CreatedBlerp> {
  const seconds = Math.min(MAX_BLERP_SECONDS, Math.max(1, Math.round(args.seconds ?? MAX_BLERP_SECONDS)));
  const query = `mutation($url:URL!,$title:String!,$keywords:[String!]!,$color:String!,$startTime:Int!,$duration:Int!,$visibility:Visibility){
    web{biteCreateByYouTube(record:{url:$url,title:$title,keywords:$keywords,color:$color,startTime:$startTime,duration:$duration,visibility:$visibility}){_id}}
  }`;
  const d = await gql<{ web: { biteCreateByYouTube: { _id?: string } | null } }>(
    query,
    {
      url: args.url,
      title: args.title,
      keywords: args.keywords?.length ? args.keywords : ['kick', 'clip'],
      color: '#53fc18', // Kick green
      startTime: 0,
      duration: seconds * 1000,
      visibility: args.visibility ?? 'PUBLIC'
    },
    args.token
  );
  const id = d.web.biteCreateByYouTube?._id;
  if (!id) throw new Error('Blerp created no sound');
  return { id, title: args.title, url: `https://blerp.com/soundbites/${id}` };
}

/**
 * Offer a sound to a streamer's board. Returns the suggestion and its state;
 * PENDING is the expected answer, meaning it is waiting on the streamer.
 */
export async function suggestToStreamer(args: {
  biteId: string;
  streamerId: string;
  token: string;
}): Promise<Suggestion> {
  const query = `mutation($biteId:MongoID!,$channelOwnerId:MongoID){
    twitch{createOneBiteSuggestion(biteId:$biteId,channelOwnerId:$channelOwnerId){_id suggestionContext{_id approvalState}}}
  }`;
  const d = await gql<{ twitch: { createOneBiteSuggestion: { _id?: string; suggestionContext?: { approvalState?: string } } | null } }>(
    query,
    { biteId: args.biteId, channelOwnerId: args.streamerId },
    args.token
  );
  const made = d.twitch.createOneBiteSuggestion;
  if (!made?._id) throw new Error('Blerp did not record the suggestion');
  return { id: made._id, approvalState: made.suggestionContext?.approvalState ?? null };
}

/** Undo: pull a sound the bot created. Used when the suggestion could not be filed. */
export async function removeBlerp(biteId: string, token: string): Promise<boolean> {
  try {
    await gql('mutation($id:MongoID!){web{biteRemoveById(_id:$id){_id}}}', { id: biteId }, token);
    return true;
  } catch {
    return false;
  }
}

export { detail as blerpErrorDetail };
