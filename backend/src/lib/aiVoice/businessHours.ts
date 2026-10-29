import { VoiceError } from "./config.js";

let holidays: { dates: Set<string>; years: Set<number>; fetchedAt: number } | undefined;

export async function businessHours(now = new Date(Date.now())): Promise<{ open: boolean; reason: string }> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", weekday: "short", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  const hour = Number(value("hour"));
  if (["Sat", "Sun"].includes(value("weekday")) || hour < 9 || hour >= 17) {
    return { open: false, reason: "Matthew takes live calls Monday to Friday, 9 am to 5 pm UK time, excluding England and Wales bank holidays." };
  }
  if (!holidays || Date.now() - holidays.fetchedAt >= 86_400_000) {
    const response = await fetch("https://www.gov.uk/bank-holidays.json", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new VoiceError(503, "Bank holiday checking is unavailable. Do not offer a live transfer; take a message or book instead.");
    const body: unknown = await response.json();
    const division = body && typeof body === "object" && "england-and-wales" in body ? body["england-and-wales"] : null;
    const events = division && typeof division === "object" && "events" in division ? division.events : null;
    if (!Array.isArray(events) || !events.length || !events.every((event: unknown) =>
      !!event && typeof event === "object" && "date" in event && typeof event.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(event.date))) {
      throw new VoiceError(503, "Bank holiday data is invalid. Do not offer a live transfer; take a message or book instead.");
    }
    const dates = new Set<string>(events.map((event: { date: string }) => event.date));
    holidays = { dates, years: new Set([...dates].map((date) => Number(date.slice(0, 4)))), fetchedAt: Date.now() };
  }
  if (!holidays.years.has(Number(value("year")))) {
    throw new VoiceError(503, "Bank holiday data does not cover this year. Take a message or book instead of transferring.");
  }
  const date = `${value("year")}-${value("month")}-${value("day")}`;
  return holidays.dates.has(date)
    ? { open: false, reason: "Matthew is unavailable for live transfers on this England and Wales bank holiday. Offer a message or meeting." }
    : { open: true, reason: "Within UK business hours. Matthew can be tried, but availability is not guaranteed." };
}
