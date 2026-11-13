import test from 'node:test';
import assert from 'node:assert/strict';
import { SlotSet, parseTime, formatTime, toMinutes, fromMinutes } from '../src/index.js';

const utc = (iso) => new Date(iso);

// A simple set: weekdays 09:00-17:00 in Europe/Berlin.
const weekdays = new SlotSet(
  [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })),
  'Europe/Berlin',
);

test('parseTime accepts HH:MM and rejects junk', () => {
  assert.equal(parseTime('00:00'), 0);
  assert.equal(parseTime('09:30'), 9 * 60 + 30);
  assert.equal(parseTime('23:59'), 23 * 60 + 59);
  assert.throws(() => parseTime('24:00'), /out of range/);
  assert.throws(() => parseTime('9:5'), /expected HH:MM/);
  assert.throws(() => parseTime(900), /must be a string/);
});

test('formatTime wraps out-of-range minutes', () => {
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(9 * 60 + 5), '09:05');
  assert.equal(formatTime(-1), '23:59');
  assert.equal(formatTime(24 * 60), '00:00');
});

test('toMinutes and fromMinutes round-trip', () => {
  assert.equal(toMinutes(0, 0), 0);
  assert.equal(toMinutes(6, 23 * 60 + 59), 7 * 24 * 60 - 1);
  assert.deepEqual(fromMinutes(0), { day: 0, minutes: 0 });
  assert.deepEqual(fromMinutes(7 * 24 * 60), { day: 0, minutes: 0 });
  assert.deepEqual(fromMinutes(-1), { day: 6, minutes: 23 * 60 + 59 });
});

test('weekday window is open during Berlin business hours', () => {
  // 2024-01-08 is a Monday. 10:00 Berlin = 09:00 UTC (CET, UTC+1).
  assert.equal(weekdays.isOpen(utc('2024-01-08T09:00:00Z')), true);
  assert.equal(weekdays.isOpen(utc('2024-01-08T15:59:00Z')), true);
});

test('weekday window is closed before and after', () => {
  assert.equal(weekdays.isOpen(utc('2024-01-08T07:59:00Z')), false);
  assert.equal(weekdays.isOpen(utc('2024-01-08T16:00:00Z')), false);
});

test('weekend is closed', () => {
  // 2024-01-13 is a Saturday.
  assert.equal(weekdays.isOpen(utc('2024-01-13T12:00:00Z')), false);
});

test('window boundary is half-open: start included, end excluded', () => {
  const set = new SlotSet([{ day: 1, start: '09:00', end: '10:00' }], 'UTC');
  assert.equal(set.isOpen(utc('2024-01-08T09:00:00Z')), true);
  assert.equal(set.isOpen(utc('2024-01-08T10:00:00Z')), false);
});

test('overnight window wraps into the next day', () => {
  // Monday 22:00 to Tuesday 02:00 in UTC.
  const set = new SlotSet([{ day: 1, start: '22:00', end: '02:00' }], 'UTC');
  assert.equal(set.isOpen(utc('2024-01-08T22:00:00Z')), true);
  assert.equal(set.isOpen(utc('2024-01-08T23:59:00Z')), true);
  assert.equal(set.isOpen(utc('2024-01-09T01:59:00Z')), true);
  assert.equal(set.isOpen(utc('2024-01-09T02:00:00Z')), false);
  assert.equal(set.isOpen(utc('2024-01-08T21:59:00Z')), false);
});

test('a window ending exactly at midnight does not leak into next day', () => {
  const set = new SlotSet([{ day: 1, start: '22:00', end: '00:00' }], 'UTC');
  assert.equal(set.isOpen(utc('2024-01-08T23:59:00Z')), true);
  assert.equal(set.isOpen(utc('2024-01-09T00:00:00Z')), false);
});

test('zero-length window is rejected at construction', () => {
  assert.throws(
    () => new SlotSet([{ day: 1, start: '09:00', end: '09:00' }], 'UTC'),
    /zero length/,
  );
});

test('invalid day is rejected at construction', () => {
  assert.throws(() => new SlotSet([{ day: 7, start: '09:00', end: '10:00' }], 'UTC'), /0\.\.6/);
  assert.throws(() => new SlotSet([{ day: 1.5, start: '09:00', end: '10:00' }], 'UTC'), /0\.\.6/);
});

test('isOpenNow uses the injected clock', () => {
  const fixed = new Date('2024-01-08T09:30:00Z');
  const set = new SlotSet([{ day: 1, start: '09:00', end: '17:00' }], 'UTC', () => fixed);
  assert.equal(set.isOpenNow(), true);
  const closed = new SlotSet([{ day: 1, start: '09:00', end: '17:00' }], 'UTC', () => new Date('2024-01-08T18:00:00Z'));
  assert.equal(closed.isOpenNow(), false);
});

test('isOpen rejects invalid dates', () => {
  assert.throws(() => weekdays.isOpen(new Date('nope')), /valid Date/);
});

test('multiple windows are unioned', () => {
  const set = new SlotSet(
    [
      { day: 1, start: '09:00', end: '12:00' },
      { day: 1, start: '13:00', end: '17:00' },
    ],
    'UTC',
  );
  assert.equal(set.isOpen(utc('2024-01-08T10:00:00Z')), true);
  assert.equal(set.isOpen(utc('2024-01-08T12:30:00Z')), false);
  assert.equal(set.isOpen(utc('2024-01-08T14:00:00Z')), true);
});

test('timezone shift is honoured', () => {
  // Monday 09:00 in Tokyo is Sunday 00:00 UTC. A Monday 09:00-10:00 Tokyo
  // window should be open at that UTC instant.
  const set = new SlotSet([{ day: 1, start: '09:00', end: '10:00' }], 'Asia/Tokyo');
  assert.equal(set.isOpen(utc('2024-01-08T00:00:00Z')), true);
  assert.equal(set.isOpen(utc('2024-01-07T23:59:00Z')), false);
});
