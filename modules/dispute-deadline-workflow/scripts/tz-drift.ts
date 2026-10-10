// Compare the pinned zone table against whatever the host believes.
//
//   node scripts/tz-drift.ts
//
// This is a report, not a gate, and it is deliberately outside `make verify`.
// Its output depends on the version of the time-zone database compiled into
// the host's runtime, which is exactly the thing the pinned table exists to
// avoid depending on. Making it a gate would mean `make verify` failing on a
// machine that is merely more up to date than the one the table was written
// on, which teaches the wrong lesson.
//
// It is here because a real deployment does want to know when its pinned rules
// and the world's rules have parted company. Knowing is the point; failing the
// build is not.

import { MODELLED_WINDOW, ZONE_TABLE_CURRENT, offsetAt } from '../src/zones.ts';

const PROBES = [
  '2026-09-15T12:00:00Z',
  '2026-10-15T12:00:00Z',
  '2026-10-30T18:00:00Z',
  '2026-11-04T18:00:00Z',
  '2026-11-20T12:00:00Z',
  '2026-12-15T12:00:00Z',
  '2027-02-15T12:00:00Z',
].filter((iso) => {
  const instant = Date.parse(iso);
  return instant >= MODELLED_WINDOW.from && instant <= MODELLED_WINDOW.to;
});

function hostOffsetMinutes(zone: string, instant: number): number | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
    );
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    return Math.round((asUtc - instant) / 60_000);
  } catch {
    return null;
  }
}

let agreements = 0;
let disagreements = 0;
const lines: string[] = [];

for (const zone of Object.keys(ZONE_TABLE_CURRENT.zones)) {
  for (const iso of PROBES) {
    const instant = Date.parse(iso);
    const pinned = offsetAt(ZONE_TABLE_CURRENT, zone, instant);
    const host = hostOffsetMinutes(zone, instant);
    if (host === null) {
      lines.push(`  ${zone} @ ${iso}: host has no data for this zone`);
      continue;
    }
    if (host === pinned) agreements += 1;
    else {
      disagreements += 1;
      lines.push(`  ${zone} @ ${iso}: pinned ${pinned} min, host ${host} min`);
    }
  }
}

console.log(`pinned table: ${ZONE_TABLE_CURRENT.version}`);
console.log(
  `modelled window: ${new Date(MODELLED_WINDOW.from).toISOString()} to ${new Date(MODELLED_WINDOW.to).toISOString()}`,
);
console.log(`node: ${process.version}`);
console.log(`probes agreeing: ${agreements}`);
console.log(`probes disagreeing: ${disagreements}`);
if (lines.length > 0) {
  console.log('');
  console.log('differences:');
  for (const line of lines) console.log(line);
}
console.log('');
console.log('This is informational. The pinned table is the authority for every');
console.log('deadline this module computes, and a disagreement here means the');
console.log('host has moved, not that a recorded deadline was wrong.');
