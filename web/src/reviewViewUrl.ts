import { validDate } from "../../src/shared/postings.js";
import { EMPTY_REVIEW_DATE_RANGE, type ReviewDateRange, type ReviewFilter } from "./reviewRows";

const filters = new Set<string>([
  "all", "pending", "ready", "duplicate", "excluded", "suspectedDuplicate",
  "pending:settlement", "excluded:manual", "excluded:automatic", "excluded:deduplicate",
] satisfies ReviewFilter[]);

interface ReviewView {
  filter: string;
  dateRange: ReviewDateRange;
  statusFilter: ReviewFilter;
  sort: "date" | "amount" | "payee";
}

const fields = { filter: "q", statusFilter: "status", start: "from", end: "to", sort: "sort" };

export function readReviewView(params: URLSearchParams, defaultStatus: ReviewFilter): ReviewView {
  const status = params.get(fields.statusFilter) ?? "";
  const start = params.get(fields.start) ?? "";
  const end = params.get(fields.end) ?? "";
  const sort = params.get(fields.sort);
  const dateRange = { start: validDate(start) ? start : "", end: validDate(end) ? end : "" };
  if (dateRange.start && dateRange.end && dateRange.start > dateRange.end) {
    [dateRange.start, dateRange.end] = [dateRange.end, dateRange.start];
  }
  return {
    filter: params.get(fields.filter) ?? "",
    dateRange: dateRange.start || dateRange.end ? dateRange : EMPTY_REVIEW_DATE_RANGE,
    statusFilter: filters.has(status) ? status as ReviewFilter : defaultStatus,
    sort: sort === "amount" || sort === "payee" ? sort : "date",
  };
}

export function updateReviewView(params: URLSearchParams, changes: Partial<ReviewView>): void {
  const set = (name: string, value: string | undefined) => {
    if (value === undefined) return;
    if (value) params.set(name, value);
    else params.delete(name);
  };
  set(fields.filter, changes.filter);
  set(fields.statusFilter, changes.statusFilter);
  set(fields.start, changes.dateRange?.start);
  set(fields.end, changes.dateRange?.end);
  set(fields.sort, changes.sort === "date" ? "" : changes.sort);
}

export function clearReviewView(params: URLSearchParams): void {
  for (const field of Object.values(fields)) params.delete(field);
}
