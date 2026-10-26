/** @param {Date} now @param {'en-US' | 'es-MX'} locale @param {string} timeZone */
export function createDemoCalendar(now, locale, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  /** @param {Intl.DateTimeFormatPartTypes} name */
  const part = (name) => Number(parts.find((value) => value.type === name)?.value);
  const year = part('year');
  const month = part('month') - 1;
  const day = part('day');
  // UTC dates represent calendar days after resolving the visitor's timezone once.
  const today = new Date(Date.UTC(year, month, day));
  const monthStart = new Date(Date.UTC(year, month, 1));
  const previousMonth = new Date(Date.UTC(year, month - 1, 1));
  const goalMonth = new Date(Date.UTC(year, month + 2, 1));
  /** @param {Intl.DateTimeFormatOptions} options */
  const formatter = (options) => new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
  const longDate = formatter({ month: 'long', day: 'numeric', year: 'numeric' });
  const monthDate = formatter({ month: 'long', year: 'numeric' });
  const shortDate = formatter({ month: 'short', day: 'numeric', year: 'numeric' });
  /** @param {number} billingDay */
  function nextPayment(billingDay) {
    let date = new Date(Date.UTC(year, month, billingDay));
    if (date <= today) date = new Date(Date.UTC(year, month + 1, billingDay));
    return { date: date.toISOString().slice(0, 10), label: shortDate.format(date) };
  }
  /** @type {Array<{id: 'music' | 'rent' | 'internet', date: string, label: string}>} */
  const upcomingPayments = [
    { id: 'music', ...nextPayment(28) },
    { id: 'rent', ...nextPayment(1) },
    { id: 'internet', ...nextPayment(7) },
  ];
  upcomingPayments.sort((left, right) => left.date.localeCompare(right.date));
  const monthName = formatter({ month: 'long' }).format(today);
  const filenameMonth = monthName.toLowerCase();
  return {
    todayKey: today.toISOString().slice(0, 10),
    today: longDate.format(today),
    month: monthDate.format(today),
    monthName,
    previousMonth: monthDate.format(previousMonth),
    range: longDate.formatRange(monthStart, today),
    goalMonth: monthDate.format(goalMonth),
    statementFilename:
      locale === 'en-US'
        ? `statement-${filenameMonth}-${year}.pdf`
        : `estado-de-cuenta-${filenameMonth}-${year}.pdf`,
    upcomingPayments,
  };
}
