# time-slot-lib

Checks whether a given UTC instant falls within a set of recurring weekly availability windows defined in a specific IANA timezone.

```js
import { SlotSet } from './src/index.js';

// Open Monday-Friday, 09:00-17:00 Berlin time.
const hours = new SlotSet(
  [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })),
  'Europe/Berlin',
);

hours.isOpen(new Date('2024-01-08T09:00:00Z')); // true  (Mon 10:00 Berlin)
hours.isOpen(new Date('2024-01-08T16:00:00Z')); // false (Mon 17:00 Berlin, end excluded)
```

## Why this exists

Most scheduling code compares instants directly, which silently breaks the moment a user picks a timezone: a window that looks like 09:00-17:00 is really a different UTC interval every day of the year. This library fixes one timezone at construction and evaluates every window against it, so DST transitions and cross-midnight windows are handled in one place instead of at each call site.

The trade-off: windows are weekly and tied to a single zone. That covers "support hours" and "maintenance window" cases, but it cannot express one-off exceptions or per-window zones. Adding those would complicate the overlap logic for a gain this library does not need.

## Edge case you will hit

A window whose `end` is less than or equal to its `start` wraps past midnight into the next day. So `{ day: 1, start: '22:00', end: '02:00' }` is open from Monday 22:00 until Tuesday 02:00. A window with `start === end` is rejected rather than treated as 24 hours, because "no duration" and "all day" are different intents and guessing wrong is worse than failing at construction.

## API

- `new SlotSet(windows, timeZone, clock?)` — `windows` is an array of `{ day, start, end }`, where `day` is 0 (Sunday) through 6 (Saturday) and `start`/`end` are `'HH:MM'` strings in `timeZone`. `clock` is an optional function returning a `Date`, used only by `isOpenNow`.
- `set.isOpen(date)` — `date` is a `Date` or a timestamp. Returns `true` when the instant is inside any window. Intervals are half-open: `start` is included, `end` is excluded.
- `set.isOpenNow()` — calls `isOpen` with `clock()`.
- `parseTime`, `formatTime`, `toMinutes`, `fromMinutes` — small helpers for converting between `'HH:MM'` and minutes-since-midnight. `formatTime` and `fromMinutes` wrap out-of-range values.
