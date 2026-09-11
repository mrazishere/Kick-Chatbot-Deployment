import { getSession } from "@/lib/session";
import { redirect } from "next/navigation";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
// BASE_PATH is used only for plain <a href> tags — Next.js redirect() adds basePath automatically

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  if (session.userId) redirect("/");

  const { error } = await searchParams;
  const errorMessages: Record<string, string> = {
    unauthorized: "This dashboard is private — Kick sign-in required.",
    token_exchange_failed: "Kick OAuth failed. Try again.",
    user_fetch_failed: "Couldn't fetch your Kick profile. Try again.",
    state_mismatch: "Session expired. Try again.",
  };
  // Own keys only: "__proto__" or "toString" found inherited values, and rendering those crashed the page.
  const errorMsg = error ? (Object.hasOwn(errorMessages, error) ? errorMessages[error] : `Auth error: ${error}`) : null;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 px-4">
      <div className="flex flex-col items-center gap-3">
        <div className="text-4xl font-bold tracking-tight text-[#53FC18]">
          Mr-AI-is-Here
        </div>
        <p className="text-sm text-neutral-500">Kick bot management &amp; earnings analytics</p>
      </div>

      {errorMsg && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-400">
          {errorMsg}
        </div>
      )}

      <a
        href={`${BASE_PATH}/api/auth/login`}
        className="flex items-center gap-3 rounded-xl bg-[#53FC18] px-6 py-3 font-semibold text-black transition hover:brightness-90"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden>
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" />
        </svg>
        Sign in with Kick
      </a>
    </div>
  );
}
