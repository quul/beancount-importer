import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { calendarWeeks, dayKeyOffsets, dayLabel, fromDate, localToday, monthLabel, toDate, weekdays } from "./calendarDates";

export default function ManualEntryCalendar({ dateCounts, disabled, onAdd }: {
  dateCounts: ReadonlyMap<string, number>;
  disabled: boolean;
  onAdd: (date: string) => void;
}) {
  const id = useId();
  const activeDay = useRef<HTMLButtonElement>(null);
  const focusAfterMove = useRef(false);
  const yearTrigger = useRef<HTMLButtonElement>(null);
  const monthTrigger = useRef<HTMLButtonElement>(null);
  const yearInput = useRef<HTMLInputElement>(null);
  const activeMonth = useRef<HTMLButtonElement>(null);
  const [today, setToday] = useState(localToday);
  const [cursor, setCursor] = useState(today);
  const [picker, setPicker] = useState<"year" | "month" | null>(null);
  const [yearInputValue, setYearInputValue] = useState("");
  const month = cursor.slice(0, 7);
  const [year, monthNumber] = month.split("-").map(Number);
  const weeks = useMemo(() => calendarWeeks(month), [month]);

  useLayoutEffect(() => {
    if (!focusAfterMove.current) return;
    focusAfterMove.current = false;
    activeDay.current?.focus({ preventScroll: true });
  }, [cursor]);

  useLayoutEffect(() => {
    if (picker === "year") {
      yearInput.current?.focus({ preventScroll: true });
      yearInput.current?.select();
    } else if (picker === "month") {
      activeMonth.current?.focus({ preventScroll: true });
    }
  }, [picker]);

  const moveCursor = (date: Date, focus = false) => {
    if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return;
    focusAfterMove.current = focus;
    setCursor(fromDate(date));
  };
  const stepMonth = (step: number) => {
    const next = toDate(month + "-01");
    next.setUTCMonth(next.getUTCMonth() + step);
    moveCursor(next);
  };
  const closePicker = () => {
    (picker === "year" ? yearTrigger : monthTrigger).current?.focus({ preventScroll: true });
    setPicker(null);
  };
  const jumpTo = (nextYear: number, nextMonth: number) => {
    const next = toDate(month + "-01");
    next.setUTCFullYear(nextYear, nextMonth - 1);
    moveCursor(next);
    closePicker();
  };
  const inputYear = Number(yearInputValue);
  const canJumpToYear = /^\d{1,4}$/.test(yearInputValue) && inputYear >= 1;

  return <section className="manual-entry-calendar" aria-label="交易日期">
    <div className="date-filter-nav">
      <button type="button" className="btn small date-month-step" aria-label="上个月" disabled={disabled} onClick={() => stepMonth(-1)}>‹</button>
      <div className="manual-calendar-period" onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPicker(null);
      }} onKeyDown={(event) => {
        if (!picker || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        closePicker();
      }}>
        <strong className="manual-calendar-announcement" id={id + "-month"} aria-live="polite">{monthLabel.format(toDate(cursor))}</strong>
        <button ref={yearTrigger} type="button" className="btn quiet manual-calendar-period-button" disabled={disabled}
          aria-label={year + "年，选择年份"} aria-expanded={picker === "year"} aria-controls={picker === "year" ? id + "-picker" : undefined}
          onClick={() => { setYearInputValue(String(year)); setPicker(picker === "year" ? null : "year"); }}>{year}年</button>
        <button ref={monthTrigger} type="button" className="btn quiet manual-calendar-period-button" disabled={disabled}
          aria-label={monthNumber + "月，选择月份"} aria-expanded={picker === "month"} aria-controls={picker === "month" ? id + "-picker" : undefined}
          onClick={() => setPicker(picker === "month" ? null : "month")}>{monthNumber}月</button>
        {picker === "month" && <div className="manual-calendar-picker" id={id + "-picker"} role="group" aria-label="选择月份">
          <div className="manual-calendar-months">
            {Array.from({ length: 12 }, (_, index) => index + 1).map((value) =>
              <button type="button" className="btn" key={value} aria-current={value === monthNumber ? "true" : undefined}
                ref={value === monthNumber ? activeMonth : undefined} disabled={disabled} onClick={() => jumpTo(year, value)}>{value}月</button>)}
          </div>
        </div>}
        {picker === "year" && <div className="manual-calendar-picker" id={id + "-picker"} role="group" aria-label="选择年份">
          <div className="manual-calendar-year-input">
            <input ref={yearInput} aria-label="跳转年份" inputMode="numeric" maxLength={4} value={yearInputValue} disabled={disabled}
              onChange={(event) => setYearInputValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (canJumpToYear) jumpTo(inputYear, monthNumber);
              }} />
            <button type="button" className="btn" disabled={disabled || !canJumpToYear} onClick={() => jumpTo(inputYear, monthNumber)}>跳转</button>
          </div>
          <div className="manual-calendar-years">
            {Array.from({ length: 10 }, (_, index) => Math.floor(year / 10) * 10 + index).filter(Boolean).map((value) =>
              <button type="button" className="btn" key={value} aria-current={value === year ? "true" : undefined}
                disabled={disabled} onClick={() => jumpTo(value, monthNumber)}>{value}</button>)}
          </div>
        </div>}
      </div>
      <button type="button" className="btn small date-month-step" aria-label="下个月" disabled={disabled} onClick={() => stepMonth(1)}>›</button>
    </div>
    <div className="manual-calendar-toolbar">
      <p id={id + "-hint"} className="muted">每点一次日期，新增一笔</p>
      <button type="button" className="btn small quiet" title="回到当前月份" disabled={disabled} onClick={() => {
        const currentDay = localToday();
        setPicker(null);
        setToday(currentDay);
        setCursor(currentDay);
      }}>今天</button>
    </div>
    <table className="date-filter-calendar" role="grid" aria-labelledby={id + "-month"} aria-describedby={id + "-hint"}>
      <thead><tr>{weekdays.map((day) => <th key={day} scope="col" aria-label={"星期" + day}>{day}</th>)}</tr></thead>
      <tbody>{weeks.map((week, index) => <tr key={index}>{week.map((date, column) => {
        if (!date) return <td key={column} />;
        const day = fromDate(date);
        const count = dateCounts.get(day);
        return <td key={column}>
          <button type="button" className="date-filter-day manual-calendar-day" disabled={disabled}
            aria-label={dayLabel.format(date) + (count ? "，已录入 " + count + " 笔" : "")}
            aria-current={day === today ? "date" : undefined}
            tabIndex={day === cursor ? 0 : -1} ref={day === cursor ? activeDay : undefined}
            onFocus={() => setCursor(day)} onClick={() => onAdd(day)}
            onKeyDown={(event) => {
              const offset = dayKeyOffsets[event.key];
              if (offset === undefined) return;
              event.preventDefault();
              const next = new Date(date);
              next.setUTCDate(next.getUTCDate() + offset);
              moveCursor(next, true);
            }}>
            {date.getUTCDate()}{count && <small aria-hidden="true">{count}</small>}
          </button>
        </td>;
      })}</tr>)}</tbody>
    </table>
  </section>;
}
