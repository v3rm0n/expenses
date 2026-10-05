const tallinnTimestamp = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Tallinn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function shortDate(value: string | null) {
  return value ? value.slice(0, 10) : "Date not provided";
}

export function dateTime(value: string | null | undefined) {
  if (!value) return "Not yet";
  const parts = Object.fromEntries(
    tallinnTimestamp
      .formatToParts(new Date(value))
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
