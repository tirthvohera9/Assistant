export function formatReminderTime(isoString) {
  if (!isoString) return 'unknown time';

  try {
    const date = new Date(isoString);
    return date.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return isoString;
  }
}

export function getTomorrowAt9AM() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow.toISOString();
}

export function getOneHourFromNow() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

export function parseSnoozeDuration(duration) {
  if (duration === 'tomorrow') {
    return getTomorrowAt9AM();
  }
  return getOneHourFromNow();
}
