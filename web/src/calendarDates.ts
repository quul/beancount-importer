export const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
export const dayKeyOffsets: Record<string, number | undefined> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
export const monthLabel = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", timeZone: "UTC" });
export const dayLabel = new Intl.DateTimeFormat("zh-CN", { dateStyle: "full", timeZone: "UTC" });
export const fromDate = (date: Date) => date.toISOString().slice(0, 10);
export const toDate = (day: string) => new Date(day + "T00:00:00Z");

export function localToday(): string {
  const today = new Date();
  return fromDate(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())));
}

export function calendarWeeks(month: string): (Date | null)[][] {
  const first = toDate(month + "-01");
  const offset = (first.getUTCDay() + 6) % 7;
  return Array.from({ length: 6 }, (_, week) => Array.from({ length: 7 }, (_, column) => {
    const date = new Date(first);
    date.setUTCDate(week * 7 + column + 1 - offset);
    return date.getUTCMonth() === first.getUTCMonth() ? date : null;
  }));
}
