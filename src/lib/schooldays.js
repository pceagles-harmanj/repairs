'use strict';
/**
 * School-day arithmetic for loaner due dates.
 *
 * A loaner issued on Thursday with a 5-day term is due the following Thursday,
 * not Tuesday, and a due date never lands on a Saturday, a Sunday, or a day in
 * SCHOOL_HOLIDAYS. Everything here works in whole local days.
 */
const config = require('./../config');

const pad = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD in local time (not UTC - a due date is a calendar day). */
function toDayString(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromDayString(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
}

/** Expand "2026-12-21..2027-01-02, 2026-11-27" into a Set of day strings. */
function expandHolidays(list = config.loanerDue.holidays) {
  const days = new Set();
  for (const entry of list) {
    const [from, to] = String(entry).split('..').map((p) => p.trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) continue;
    if (!to) { days.add(from); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) { days.add(from); continue; }
    const cursor = fromDayString(from);
    const end = fromDayString(to);
    let guard = 0;
    while (cursor <= end && guard < 800) {
      days.add(toDayString(cursor));
      cursor.setDate(cursor.getDate() + 1);
      guard += 1;
    }
  }
  return days;
}

/** ISO weekday: Monday = 1 ... Sunday = 7. */
const isoWeekday = (date) => (date.getDay() === 0 ? 7 : date.getDay());

function isSchoolDay(date, { holidays = expandHolidays(), weekdays = config.loanerDue.schoolWeekdays } = {}) {
  const d = date instanceof Date ? date : fromDayString(date);
  if (!weekdays.includes(isoWeekday(d))) return false;
  return !holidays.has(toDayString(d));
}

/** The next school day at or after `date`. */
function nextSchoolDay(date, opts = {}) {
  const d = date instanceof Date ? new Date(date) : fromDayString(date);
  let guard = 0;
  while (!isSchoolDay(d, opts) && guard < 800) {
    d.setDate(d.getDate() + 1);
    guard += 1;
  }
  return d;
}

/**
 * Add whole school days. 0 means "today if it is a school day, else the next one",
 * which is what "due today" should mean over a weekend.
 */
function addSchoolDays(from, count, opts = {}) {
  const holidays = opts.holidays || expandHolidays();
  const weekdays = opts.weekdays || config.loanerDue.schoolWeekdays;
  const o = { holidays, weekdays };
  const d = from instanceof Date ? new Date(from) : fromDayString(from);
  d.setHours(0, 0, 0, 0);
  let left = Math.max(0, Math.floor(Number(count) || 0));
  let guard = 0;
  while (left > 0 && guard < 2000) {
    d.setDate(d.getDate() + 1);
    if (isSchoolDay(d, o)) left -= 1;
    guard += 1;
  }
  return nextSchoolDay(d, o);
}

/** School days between two days (negative when `to` is in the past). */
function schoolDaysBetween(fromDay, toDay, opts = {}) {
  const holidays = opts.holidays || expandHolidays();
  const weekdays = opts.weekdays || config.loanerDue.schoolWeekdays;
  const a = fromDayString(toDayString(fromDay instanceof Date ? fromDay : fromDayString(fromDay)));
  const b = fromDayString(toDayString(toDay instanceof Date ? toDay : fromDayString(toDay)));
  const sign = b < a ? -1 : 1;
  const start = sign === 1 ? a : b;
  const end = sign === 1 ? b : a;
  let count = 0;
  const cursor = new Date(start);
  let guard = 0;
  while (cursor < end && guard < 4000) {
    cursor.setDate(cursor.getDate() + 1);
    if (isSchoolDay(cursor, { holidays, weekdays })) count += 1;
    guard += 1;
  }
  return sign * count;
}

/** Whole calendar days between two dates, rounded toward zero. */
function calendarDaysBetween(from, to) {
  const a = fromDayString(toDayString(from));
  const b = fromDayString(toDayString(to));
  return Math.round((b - a) / 86400000);
}

/** The default due day for a loaner handed out now. */
function defaultDueDay(issuedAt = new Date()) {
  return toDayString(addSchoolDays(issuedAt, config.loanerDue.schoolDays));
}

module.exports = {
  toDayString, fromDayString, expandHolidays, isSchoolDay, nextSchoolDay,
  addSchoolDays, schoolDaysBetween, calendarDaysBetween, defaultDueDay, isoWeekday,
};
