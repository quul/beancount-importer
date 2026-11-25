import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { validDate } from "../../src/shared/postings.js";
import { EMPTY_REVIEW_DATE_RANGE, type ReviewDateRange } from "./reviewRows";
import { calendarWeeks, dayKeyOffsets, dayLabel, fromDate, localToday, monthLabel, toDate, weekdays } from "./calendarDates";

function initialDay(value: ReviewDateRange, today: string): string {
  return validDate(value.start) ? value.start : today;
}

function orderedRange(first: string, second: string): ReviewDateRange {
  return first <= second ? { start: first, end: second } : { start: second, end: first };
}

export default function DateRangeFilter({ value, onChange }: {
  value: ReviewDateRange;
  onChange: (value: ReviewDateRange) => void;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const activeDay = useRef<HTMLButtonElement>(null);
  const focusAfterMove = useRef(false);
  const monthId = useId();
  const [today, setToday] = useState(localToday);
  const [cursor, setCursor] = useState(() => initialDay(value, today));
  const [anchor, setAnchor] = useState("");
  const [previewDay, setPreviewDay] = useState("");
  const { start, end } = value;
  const active = Boolean(start || end);
  const label = start && end && start !== end ? `${start} 至 ${end}` : start || end || "日期范围";
  const month = cursor.slice(0, 7);
  const weeks = useMemo(() => calendarWeeks(month), [month]);
  const selection = anchor ? orderedRange(anchor, previewDay || anchor) : value;

  useLayoutEffect(() => {
    if (focusAfterMove.current) {
      focusAfterMove.current = false;
      activeDay.current?.focus({ preventScroll: true });
    }
  }, [cursor]);

  useEffect(() => {
    const dismiss = (event: Event) => {
      const details = disclosure.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, []);

  const close = () => {
    const details = disclosure.current;
    if (!details) return;
    details.open = false;
    details.querySelector("summary")?.focus({ preventScroll: true });
  };

  const moveCursor = (date: Date, focus: boolean) => {
    if (date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999) return;
    const day = fromDate(date);
    focusAfterMove.current = focus;
    setCursor(day);
    setPreviewDay(focus && anchor ? day : "");
  };

  const stepMonth = (step: number) => {
    const next = toDate(`${month}-01`);
    next.setUTCMonth(next.getUTCMonth() + step);
    moveCursor(next, false);
  };

  const selectDay = (day: string) => {
    if (anchor) {
      onChange(orderedRange(anchor, day));
      close();
      return;
    }
    setCursor(day);
    setAnchor(day);
    setPreviewDay("");
  };

  return <details ref={disclosure} className="date-filter" onKeyDown={(event) => {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.preventDefault();
    close();
  }}>
    <summary className={`btn${active ? " date-filter-active" : ""}`} aria-label={active ? `日期范围 · ${label}` : label} onClick={() => {
      if (disclosure.current?.open) return;
      const currentDay = localToday();
      setToday(currentDay);
      setCursor(initialDay(value, currentDay));
      setAnchor("");
      setPreviewDay("");
    }}>{label}</summary>
    <div className="date-filter-panel" role="region" aria-label="日期范围">
      <div className="date-filter-nav">
        <button type="button" className="btn small date-month-step" aria-label="上个月" onClick={() => stepMonth(-1)}>‹</button>
        <strong id={monthId} aria-live="polite">{monthLabel.format(toDate(cursor))}</strong>
        <button type="button" className="btn small date-month-step" aria-label="下个月" onClick={() => stepMonth(1)}>›</button>
      </div>
      <table className="date-filter-calendar" role="grid" aria-labelledby={monthId} aria-multiselectable="true"
        onPointerLeave={() => setPreviewDay("")}>
        <thead><tr>{weekdays.map((day) => <th key={day} scope="col" aria-label={`星期${day}`}>{day}</th>)}</tr></thead>
        <tbody>{weeks.map((week, index) => <tr key={index}>{week.map((date, column) => {
          if (!date) return <td key={column} />;
          const day = fromDate(date);
          const inRange = day >= selection.start && day <= selection.end;
          const selected = anchor ? day === anchor : inRange;
          const rangeClass = inRange ? ` in-range${day === selection.start ? " range-start" : ""}${day === selection.end ? " range-end" : ""}` : "";
          return <td key={column} aria-selected={selected}>
            <button type="button" className={`date-filter-day${rangeClass}`} aria-label={dayLabel.format(date)}
              aria-current={day === today ? "date" : undefined}
              tabIndex={day === cursor ? 0 : -1} ref={day === cursor ? activeDay : undefined}
              onFocus={() => setCursor(day)} onClick={() => selectDay(day)}
              onPointerEnter={() => { if (anchor) setPreviewDay(day); }}
              onKeyDown={(event) => {
                const offset = dayKeyOffsets[event.key];
                if (offset === undefined) return;
                event.preventDefault();
                const next = new Date(date);
                next.setUTCDate(next.getUTCDate() + offset);
                moveCursor(next, true);
              }}>{date.getUTCDate()}</button>
          </td>;
        })}</tr>)}</tbody>
      </table>
      <div className="toolbar date-filter-actions">
        <span className="muted" role="status">{anchor ? `${anchor} · 选择结束日期` : "选择开始日期"}</span>
        <button type="button" className="btn small" disabled={!active && !anchor}
          onClick={() => { onChange(EMPTY_REVIEW_DATE_RANGE); close(); }}>清除</button>
      </div>
    </div>
  </details>;
}
