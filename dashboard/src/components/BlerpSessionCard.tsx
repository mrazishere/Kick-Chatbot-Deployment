"use client";

import { useCallback, useEffect, useState } from "react";
import { AudioLines } from "lucide-react";
import { Button, Card } from "./ui";

// The dashboard is served under a base path, and a client-side fetch does not
// pick it up the way a <Link> does — a bare "/api/..." leaves the app entirely.
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * !blerp signs in to Blerp as the bot account with a JWT that lives about 20
 * days. The bot renews it with a refresh token, but once that chain breaks a
 * fresh login has to come from a browser. This card takes the jwt cookie from
 * that login; the bot verifies it, mints a new refresh token from it and goes
 * back to renewing by itself.
 *
 * The token is write-only — the server never sends one back to the browser.
 */
interface Status {
  healthy: boolean;
  hasToken: boolean;
  username: string | null;
  expiresAt: number | null;
  selfRenewing: boolean;
  lastVerifyAt: number | null;
  lastReason: string | null;
  tokenSavedAt: number | null;
}

function when(ms: number | null): string {
  if (!ms) return "never";
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

function expiry(ms: number | null): string {
  if (!ms) return "expiry unknown";
  const days = Math.floor((ms - Date.now()) / 86_400_000);
  if (ms <= Date.now()) return "expired";
  return days < 1 ? "expires today" : `expires in ${days}d`;
}

export default function BlerpSessionCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/blerp-session`, { cache: "no-store" });
      if (res.ok) setStatus((await res.json()) as Status);
    } catch {
      /* the card simply shows nothing rather than breaking the page */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    const value = token.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`${BASE_PATH}/api/blerp-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: value }),
      });
      const body = (await res.json()) as Status & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "That jwt could not be installed");
        return;
      }
      // Clear it from the field as soon as it is stored: it is a full login for
      // the bot's Blerp account and has no reason to sit in the page.
      setToken("");
      setSaved(true);
      setStatus(body);
    } catch {
      setError("Could not reach the bot service");
    } finally {
      setBusy(false);
    }
  }, [token]);

  const healthy = status?.healthy ?? true;

  return (
    <Card
      title="Blerp login"
      icon={<AudioLines className="h-4 w-4" />}
      actions={
        status ? (
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              healthy ? "bg-[#53FC18]/10 text-[#53FC18]" : "bg-red-950/60 text-red-400"
            }`}
          >
            {healthy ? "working" : "needs a new login"}
          </span>
        ) : null
      }
    >
      {status && !healthy && status.lastReason ? (
        <p className="mb-4 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          {status.lastReason}
        </p>
      ) : null}

      <ol className="mb-4 space-y-1 text-xs text-neutral-400">
        <li>1. Open blerp.com and sign in as the bot account</li>
        <li>2. F12 → Application → Cookies → blerp.com → copy <code className="text-neutral-300">jwt</code></li>
        <li>3. Paste it below and save — the whole <code className="text-neutral-300">jwt:&quot;…&quot;</code> line is fine, no need to trim it</li>
        <li>4. The bot renews it by itself from then on</li>
      </ol>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="password"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setSaved(false);
            setError(null);
          }}
          placeholder={'Paste jwt:"…" or just the value'}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-500"
        />
        <Button onClick={save} disabled={!token.trim()} busy={busy} variant="primary">
          Save and verify
        </Button>
      </div>

      {error ? <p className="mt-3 text-xs text-red-400">{error}</p> : null}
      {saved && status ? (
        <p className={`mt-3 text-xs ${status.selfRenewing ? "text-[#53FC18]" : "text-amber-400"}`}>
          {status.selfRenewing
            ? `Verified with Blerp as ${status.username ?? "the bot"} — !blerp works and renews itself from now on.`
            : `Verified with Blerp as ${status.username ?? "the bot"}, but no refresh token came with it, so it will need pasting again before it expires. Logging out of blerp.com and back in, then pasting the new jwt, usually fixes that.`}
        </p>
      ) : null}

      {status ? (
        <p className="mt-4 text-xs text-neutral-600">
          {status.hasToken ? `Signed in${status.username ? ` as ${status.username}` : ""} · ${expiry(status.expiresAt)}` : "No token stored"}
          {status.hasToken ? (status.selfRenewing ? " · renews itself" : " · won't renew by itself") : null}
          {" · "}last checked {when(status.lastVerifyAt)}
          {status.tokenSavedAt ? ` · saved ${when(status.tokenSavedAt)}` : null}
        </p>
      ) : null}
    </Card>
  );
}
