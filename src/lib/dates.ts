const tallinnTimestamp = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Tallinn",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const calendarDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function monthLabel(value: string, short = false) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    month: short ? "short" : "long",
    year: short ? "2-digit" : "numeric",
  }).format(new Date(`${value}-01T12:00:00Z`));
}

export function shortDate(value: string | null) {
  return value
    ? calendarDate.format(new Date(`${value.slice(0, 10)}T12:00:00Z`))
    : "Date not provided";
}

export function dateTime(value: string | null | undefined) {
  if (!value) return "Not yet";
  const parts = Object.fromEntries(
    tallinnTimestamp
      .formatToParts(new Date(value))
      .map(({ type, value }) => [type, value]),
  );
  return `${Number(parts.day)} ${parts.month} ${parts.year} ${parts.hour}:${parts.minute}`;
}
