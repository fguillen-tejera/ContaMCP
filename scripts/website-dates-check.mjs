import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDemoCalendar } from '../website/demo-dates.js';

test('month-to-date uses the visitor’s calendar day rather than the UTC date', () => {
  const now = new Date('2027-03-01T01:00:00Z');
  const west = createDemoCalendar(now, 'en-US', 'America/Los_Angeles');
  const east = createDemoCalendar(now, 'en-US', 'Asia/Tokyo');
  assert.equal(west.todayKey, '2027-02-28');
  assert.equal(west.monthName, 'February');
  assert.match(west.range, /February 1.*28, 2027/);
  assert.equal(east.todayKey, '2027-03-01');
  assert.equal(east.range, 'March 1, 2027');
});

test('leap days stay in February and upcoming payments are strictly in the future', () => {
  const calendar = createDemoCalendar(new Date('2028-02-29T18:00:00Z'), 'en-US', 'UTC');
  assert.equal(calendar.today, 'February 29, 2028');
  assert.match(calendar.range, /February 1.*29, 2028/);
  assert.deepEqual(
    calendar.upcomingPayments.map((payment) => payment.date),
    ['2028-03-01', '2028-03-07', '2028-03-28'],
  );
  assert.equal(calendar.goalMonth, 'April 2028');
});

test('December rolls upcoming payments and the savings goal into the next year', () => {
  const calendar = createDemoCalendar(new Date('2026-12-31T12:00:00Z'), 'en-US', 'UTC');
  assert.equal(calendar.month, 'December 2026');
  assert.equal(calendar.previousMonth, 'November 2026');
  assert.equal(calendar.goalMonth, 'February 2027');
  assert.equal(calendar.statementFilename, 'statement-december-2026.pdf');
  assert.deepEqual(
    calendar.upcomingPayments.map((payment) => payment.date),
    ['2027-01-01', '2027-01-07', '2027-01-28'],
  );
});

test('January comparisons point to the previous year and Spanish copy is localized', () => {
  const calendar = createDemoCalendar(
    new Date('2027-01-01T18:00:00Z'),
    'es-MX',
    'America/Mexico_City',
  );
  assert.equal(calendar.todayKey, '2027-01-01');
  assert.equal(calendar.today, '1 de enero de 2027');
  assert.equal(calendar.month, 'enero de 2027');
  assert.equal(calendar.previousMonth, 'diciembre de 2026');
  assert.equal(calendar.range, '1 de enero de 2027');
  assert.equal(calendar.statementFilename, 'estado-de-cuenta-enero-2027.pdf');
});

test('a billing day that is today moves to the next occurrence', () => {
  const calendar = createDemoCalendar(new Date('2027-04-28T12:00:00Z'), 'en-US', 'UTC');
  assert.equal(
    calendar.upcomingPayments.find((payment) => payment.id === 'music')?.date,
    '2027-05-28',
  );
});

test('upcoming payment order stays chronological at every month boundary', () => {
  for (let month = 0; month < 12; month++) {
    for (const date of [
      new Date(Date.UTC(2028, month, 1)),
      new Date(Date.UTC(2028, month + 1, 0)),
    ]) {
      const calendar = createDemoCalendar(date, 'en-US', 'UTC');
      const dates = calendar.upcomingPayments.map((payment) => payment.date);
      assert.ok(dates.every((paymentDate) => paymentDate > calendar.todayKey));
      assert.deepEqual(dates, [...dates].sort());
      assert.equal(new Set(calendar.upcomingPayments.map((payment) => payment.id)).size, 3);
    }
  }
});
