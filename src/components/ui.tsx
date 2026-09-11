/**
 * The small building blocks the bot page's cards share. Kept in their own file so
 * a card that lives outside BotManager (PointsCard) looks the same without copying them.
 */

import { Loader2 } from "lucide-react";

export function Card({
  title, icon, children, actions,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-950/60">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 px-5 py-3.5">
        <h2 className="flex items-center gap-2.5 text-sm font-semibold tracking-wide text-neutral-200">
          <span className="text-neutral-500">{icon}</span>
          {title}
        </h2>
        {actions}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "warn" }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-neutral-500">{label}</dt>
      <dd className={`mt-1 text-sm tabular-nums ${tone === "warn" ? "text-amber-400" : "text-neutral-200"}`}>
        {value}
      </dd>
    </div>
  );
}

export function Button({
  children, onClick, disabled, busy, variant = "default",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  variant?: "default" | "primary" | "danger";
}) {
  const base =
    "inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40";
  const styles = {
    default: "border border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-neutral-600 hover:bg-neutral-800",
    primary: "bg-[#53FC18] text-black hover:brightness-90",
    danger: "border border-red-900 bg-red-950/50 text-red-400 hover:bg-red-950",
  }[variant];

  return (
    <button type="button" onClick={onClick} disabled={disabled || busy} className={`${base} ${styles}`}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {children}
    </button>
  );
}

export function Checkbox({
  label, checked, disabled, onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex items-center gap-2.5 text-sm text-neutral-300 ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[#53FC18]"
      />
      {label}
    </label>
  );
}

export function Toggle({
  label, description, checked, disabled, onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div>
        <div className="text-sm font-medium text-neutral-200">{label}</div>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">{description}</p>
      </div>
      <button
        type="button"
        onClick={onChange}
        disabled={disabled}
        aria-pressed={checked}
        aria-label={label}
        className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-40 ${
          checked ? "bg-[#53FC18]" : "bg-neutral-700"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
            checked ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}
