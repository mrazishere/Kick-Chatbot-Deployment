"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import { Button } from "./ui";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type Status = { configured: boolean; channelId: string | null; savedAt: string | null };

/**
 * The streamer pastes their StreamElements JWT here so the video overlay can follow their
 * media share. Write-only: once saved the token is never shown again, only that it's set.
 * The bot checks it against StreamElements before keeping it.
 */
export default function MediaShareSetup({ channel, canAdminister }: { channel: string; canAdminister: boolean }) {
  const url = `${BASE_PATH}/api/bot/${encodeURIComponent(channel)}/mediashare`;
  const [status, setStatus] = useState<Status | null>(null);
  const [jwt, setJwt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const call = useCallback(async (method: "GET" | "PUT" | "DELETE", body?: unknown) => {
    const res = await fetch(url, { method, cache: "no-store", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const out = (await res.json().catch(() => ({}))) as Status & { error?: string };
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    return out;
  }, [url]);

  useEffect(() => {
    if (!canAdminister) return;
    call("GET").then(setStatus).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [call, canAdminister]);

  if (!canAdminister) {
    return <p className="text-xs text-neutral-500">Only the channel&apos;s owner can connect StreamElements media share.</p>;
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setStatus(await call("PUT", { jwt }));
      setJwt("");
      setNotice("Saved and checked with StreamElements.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setStatus(await call("DELETE"));
      setNotice("Removed. The overlay stops following media share.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
      <p className="text-sm text-neutral-200">StreamElements media share</p>
      <p className="mt-0.5 text-xs text-neutral-500">
        With this connected and &quot;Play my media share on the video overlay&quot; ticked, the video overlay plays whatever your media share plays, in step
        with it: when it starts, pauses, skips or moves on, the overlay follows within about a second.
      </p>

      <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-neutral-400">
        <li>
          Open{" "}
          <a href="https://streamelements.com/dashboard/account/channels" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[#53FC18] hover:underline">
            StreamElements → Account → Channels <ExternalLink className="h-3 w-3" />
          </a>{" "}
          (signed in to the account your media share runs on).
        </li>
        <li>Click <b className="text-neutral-200">Show secrets</b>, then copy the <b className="text-neutral-200">JWT Token</b>, the long one, not the overlay token.</li>
        <li>Paste it below and press <b className="text-neutral-200">Save token</b>. It&apos;s checked with StreamElements before it&apos;s kept.</li>
      </ol>
      <p className="mt-2 text-xs text-amber-300/80">
        The JWT opens your whole StreamElements account, so keep it private: paste it only here, never in chat. The bot only uses it to see what media
        share is playing. To cut it off at any time, press Remove below, or regenerate it on the same StreamElements page.
      </p>

      <div className="mt-3 flex items-center gap-2 text-xs">
        {status?.configured ? (
          <span className="inline-flex items-center gap-1 text-[#53FC18]">
            <Check className="h-3.5 w-3.5" /> Connected
            {status.savedAt ? <span className="text-neutral-500">· saved {new Date(status.savedAt).toLocaleString()}</span> : null}
          </span>
        ) : (
          <span className="text-neutral-500">{status ? "Not connected" : "Checking…"}</span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={jwt}
          onChange={(e) => setJwt(e.target.value)}
          placeholder={status?.configured ? "Paste a new JWT token to replace it" : "Paste your StreamElements JWT token"}
          className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 font-mono text-xs text-neutral-200"
        />
        <Button variant="primary" onClick={() => void save()} busy={busy} disabled={!jwt.trim()}>
          Save token
        </Button>
        {status?.configured ? (
          <Button onClick={() => void remove()} disabled={busy}>
            Remove
          </Button>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      {notice && !error ? <p className="mt-2 text-xs text-[#53FC18]">{notice}</p> : null}
    </div>
  );
}
