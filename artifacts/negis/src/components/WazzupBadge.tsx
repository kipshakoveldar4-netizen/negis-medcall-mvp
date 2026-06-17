interface WazzupBadgeProps {
  count: number;
}

export function WazzupBadge({ count }: WazzupBadgeProps) {
  if (count <= 0) return null;
  return (
    <span className="ml-2 inline-flex min-w-5 h-5 items-center justify-center rounded-full bg-[#16A34A] px-1.5 text-[11px] font-bold text-white">
      {count > 99 ? '99+' : count}
    </span>
  );
}
