export function BrandMark() {
  return (
    <span className="inline-flex items-center gap-2 font-semibold">
      <svg viewBox="0 0 32 32" className="size-6" aria-hidden="true">
        <rect width="32" height="32" rx="8" className="fill-fd-primary" />
        <path
          d="M11 21 21 11"
          className="stroke-fd-primary-foreground"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="10" cy="22" r="4" className="fill-fd-primary-foreground" />
        <circle
          cx="22"
          cy="10"
          r="4"
          fill="none"
          className="stroke-fd-primary-foreground"
          strokeWidth="2.5"
        />
      </svg>
      <span className="text-[15px] tracking-tight">mate</span>
    </span>
  );
}
