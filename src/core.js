// Time slot validator: checks whether a UTC instant falls inside a set of
// recurring weekly availability windows expressed in a fixed IANA timezone.
//
// Design notes:
// - We pin one timezone at construction. Mixing zones per window would make
//   overlap questions ambiguous, and the brief asks for "a specific timezone".
// - Windows are weekly: { day: 0..6 (Sun..Sat), start: 'HH:MM', end: 'HH:MM' }
//   in the configured zone. A window whose end <= start wraps past midnight
//   into the next day. This is the single interpretation we commit to; see
//   README for the consequences.
// - We never call Date.now() internally. Callers pass a Date (or a number).
//   This keeps the library testable without mocking global time.

const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

// Parses 'HH:MM' (24h) into minutes since local midnight. Throws on anything
// else so bad configuration fails loudly at construction, not at query time.
export function parseTime(text) {
  if (typeof text !== 'string') {
    throw new TypeError('time must be a string in HH:MM form');
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) {
    throw new Error(`invalid time ${JSON.stringify(text)}, expected HH:MM`);
  }
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) {
    throw new Error(`invalid time ${JSON.stringify(text)}: out of range`);
  }
  return h * 60 + min;
}

// Formats minutes-since-midnight back to 'HH:MM'. Values outside [0, 1440)
// are wrapped, which is what callers want when normalising window ends.
export function formatTime(minutes) {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Converts a day + minutes pair into a single minute index within the week.
// Sunday 00:00 is 0. This linearisation is what makes overlap checks easy.
export function toMinutes(day, minutesIntoDay) {
  return day * MINUTES_PER_DAY + minutesIntoDay;
}

// Inverse of toMinutes. Returns { day, minutes }.
export function fromMinutes(total) {
  const wrapped = ((total % MINUTES_PER_WEEK) + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
  return {
    day: Math.floor(wrapped / MINUTES_PER_DAY),
    minutes: wrapped % MINUTES_PER_DAY,
  };
}

// Normalises a window into a half-open interval [start, end) on the week's
// minute line. A window with end <= start is treated as wrapping into the
// next day, so its end lands on day+1.
function normaliseWindow(win) {
  if (win === null || typeof win !== 'object') {
    throw new TypeError('window must be an object');
  }
  const { day, start, end } = win;
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    throw new Error(`window.day must be an integer 0..6, got ${JSON.stringify(day)}`);
  }
  const startMin = parseTime(start);
  const endMin = parseTime(end);
  const startAbs = toMinutes(day, startMin);
  let endAbs = toMinutes(day, endMin);
  if (endAbs <= startAbs) {
    // Wrap past midnight. A zero-length window (start === end) is rejected
    // rather than silently treated as 24h; that ambiguity is not useful.
    if (endMin === startMin) {
      throw new Error(`window on day ${day} has zero length (${start}..${end})`);
    }
    endAbs += MINUTES_PER_DAY;
  }
  return { startAbs, endAbs };
}

// Returns the local weekday and minutes-since-midnight for a UTC Date in the
// given IANA timezone. Uses Intl, which is standard and dependency-free.
function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type);
  const weekdayPart = get('weekday');
  const hourPart = get('hour');
  const minutePart = get('minute');
  if (!weekdayPart || !hourPart || !minutePart) {
    throw new Error('failed to read local time parts');
  }
  const dayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekdayPart.value];
  if (dayIndex === undefined) {
    throw new Error(`unknown weekday ${weekdayPart.value}`);
  }
  // Intl may return '24' for midnight in some engines; normalise it.
  const hour = Number(hourPart.value) % 24;
  const minute = Number(minutePart.value);
  return { day: dayIndex, minutes: hour * 60 + minute };
}

export class SlotSet {
  // `windows` is an array of { day, start, end } objects. `timeZone` is an
  // IANA name such as 'Europe/Berlin'. `clock` is optional and only used by
  // isOpenNow; it defaults to the real clock but tests can inject a fake.
  constructor(windows, timeZone, clock = () => new Date()) {
    if (typeof timeZone !== 'string' || timeZone.length === 0) {
      throw new TypeError('timeZone must be a non-empty IANA name');
    }
    if (typeof clock !== 'function') {
      throw new TypeError('clock must be a function returning a Date');
    }
    if (!Array.isArray(windows)) {
      throw new TypeError('windows must be an array');
    }
    this.timeZone = timeZone;
    this.clock = clock;
    this.windows = windows.map(normaliseWindow);
  }

  // True when the instant falls inside any window. The check is half-open:
  // a window [start, end) contains start but not end, so adjacent windows
  // do not double-count their touching boundary.
  isOpen(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) {
      throw new TypeError('date must be a valid Date or timestamp');
    }
    const { day, minutes } = localParts(d, this.timeZone);
    const abs = toMinutes(day, minutes);
    for (const win of this.windows) {
      if (abs >= win.startAbs && abs < win.endAbs) {
        return true;
      }
      // A wrapped window can also cover the tail of the previous week, so
      // compare against the same window shifted back by one week.
      if (abs + MINUTES_PER_WEEK >= win.startAbs && abs + MINUTES_PER_WEEK < win.endAbs) {
        return true;
      }
    }
    return false;
  }

  // Convenience wrapper around the injected clock. Kept small on purpose:
  // all real logic lives in isOpen so tests can drive it directly.
  isOpenNow() {
    return this.isOpen(this.clock());
  }
}
