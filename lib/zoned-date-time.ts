export type ZonedDateTimeParts = Record<
  "year" | "month" | "day" | "hour" | "minute",
  string
>;

export function zonedDateTimeParts(date: Date, timeZone: string): ZonedDateTimeParts {
  const entries = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]);
  return Object.fromEntries(entries) as ZonedDateTimeParts;
}

export function zonedDateTimeValue(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const parts = zonedDateTimeParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function zonedDateValue(value: string, timeZone: string): string {
  return zonedDateTimeValue(value, timeZone).slice(0, 10);
}

export function zonedLocalDateTimeIso(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  let guess = target;
  try {
    for (let pass = 0; pass < 4; pass += 1) {
      const parts = zonedDateTimeParts(new Date(guess), timeZone);
      const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
      const difference = target - represented;
      if (difference === 0) break;
      guess += difference;
    }
    const resolved = zonedDateTimeParts(new Date(guess), timeZone);
    const expected = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}`;
    return `${resolved.year}-${resolved.month}-${resolved.day}T${resolved.hour}:${resolved.minute}` === expected
      ? new Date(guess).toISOString()
      : null;
  } catch {
    return null;
  }
}

export function replaceZonedDate(source: string, date: string, timeZone: string): string | null {
  const current = zonedDateTimeValue(source, timeZone);
  return /^\d{4}-\d{2}-\d{2}$/u.test(date) && current
    ? zonedLocalDateTimeIso(`${date}${current.slice(10)}`, timeZone)
    : null;
}
