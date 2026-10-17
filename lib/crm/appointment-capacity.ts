export function findAppointmentCapacityConflict<T>(
  candidate: { start: number; end: number },
  intervals: Array<{ start: number; end: number; value: T }>,
  capacity: number,
): T | null {
  if (!Number.isFinite(candidate.start) || !Number.isFinite(candidate.end) || candidate.end <= candidate.start) return null;
  const limit = Number.isFinite(capacity) && capacity >= 1 ? Math.trunc(capacity) : 1;
  const events: Array<{ time: number; delta: number; index: number }> = [];

  intervals.forEach((interval, index) => {
    if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.end <= interval.start) return;
    const start = Math.max(candidate.start, interval.start);
    const end = Math.min(candidate.end, interval.end);
    if (end <= start) return;
    events.push({ time: start, delta: 1, index }, { time: end, delta: -1, index });
  });
  // Half-open intervals release their place before another starts at that instant.
  events.sort((a, b) => a.time - b.time || a.delta - b.delta || a.index - b.index);

  const active = new Set<number>();
  for (const event of events) {
    if (event.delta < 0) active.delete(event.index);
    else {
      active.add(event.index);
      if (active.size >= limit) return intervals[event.index].value;
    }
  }
  return null;
}
