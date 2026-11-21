import assert from "node:assert/strict";
import { api, ApiError } from "../web/src/api.js";
import { draftDecision, invalidTags, makeDraft, parseTags } from "../web/src/ReviewEditor.js";
import { applyPendingReviewPatches, reviewPatches, type ReviewPatches } from "../web/src/reviewChanges.js";
import { buildBulkPostingPlan, buildReviewRows, matchesReviewDateRange, matchesReviewFilter, matchesReviewSearch } from "../web/src/reviewRows.js";
import { LEDGER_DUPLICATE_ISSUE } from "../src/shared/types.js";
import { planCategoryAllocations, savedCategoryAllocations } from "../src/shared/categoryAllocations.js";
import type { ParsedTx } from "../src/shared/types.js";

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; init?: RequestInit }> = [];
let nextResponse: unknown = {};
let status = 200;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  requests.push({ url: String(url), init });
  if (nextResponse instanceof Response) return nextResponse;
  return new Response(nextResponse === undefined ? null : JSON.stringify(nextResponse), { status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

try {
  nextResponse = { ledgerRoot: "fixture", mainFile: "main.bean" };
  assert.equal((await api.config()).mainFile, "main.bean");
  await api.decide("batch/one", 7, [{ id: "row", funding: "Assets:Wallet", tags: ["checked"], flag: "!" }]);
  assert.equal(requests.at(-1)?.url, "/api/batch/batch%2Fone/decide");
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { revision: 7, decisions: [{ id: "row", funding: "Assets:Wallet", tags: ["checked"], flag: "!" }] });
  await api.decide("batch/one", 7, [{ id: "row", status: "excluded" }], true);
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { revision: 7, decisions: [{ id: "row", status: "excluded" }], changesOnly: true });
  await api.commit("batch", 8);
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { revision: 8 });
  await api.deleteBatch("batch/one", 9);
  assert.equal(requests.at(-1)?.url, "/api/batch/batch%2Fone");
  assert.equal(requests.at(-1)?.init?.method, "DELETE");
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { revision: 9 });
  console.log("✓ config is parsed; reviewed funding reaches decide; commit sends only its revision");

  assert.deepEqual(parseTags("#trip trip,checked，!bad"), ["trip", "checked", "!bad"]);
  assert.deepEqual(invalidTags("trip2026 checked.one refund/a other_tag ok-tag"), []);
  assert.deepEqual(invalidTags("中文 !invalid"), ["中文", "!invalid"]);
  console.log("✓ quick tags deduplicate and reject unsupported native tag characters");

  const refund = { id: "refund", direction: "in", amount: 8.5, currency: "CNY", fundingAccount: "Assets:Wallet", finalAccount: "Expenses:Food", flag: "!", tags: ["refund"], reviewNote: "复核" } as ParsedTx;
  const draft = makeDraft(refund);
  assert.equal(draft.flag, "!"); assert.equal(draft.postings[0].amount, "-8.5"); assert.equal(draft.postings[1].amount, "8.5");
  draft.split = true;
  const decision = draftDecision(refund, draft);
  assert.equal(decision.postings?.[0].amount, -8.5); assert.deepEqual(decision.tags, ["refund"]);
  const splitRefund = { ...refund, postings: decision.postings! };
  const splitNote = draftDecision(splitRefund, { ...makeDraft(splitRefund), reviewNote: "退款单已核实" });
  assert.ok(!Object.hasOwn(splitNote, "postings"));
  draft.split = false;
  assert.equal(draftDecision(splitRefund, draft).postings, null);
  const transfer = { ...refund, eventType: "transfer", fundingAccount2: "Assets:Bank" } satisfies ParsedTx;
  const note = draftDecision(transfer, { ...makeDraft(transfer), reviewNote: "核对了转账凭证" });
  assert.equal(note.reviewNote, "核对了转账凭证");
  assert.ok(!Object.hasOwn(note, "postings"));
  console.log("✓ refund splits can be cleared and saving a transfer note preserves the inferred accounts");

  const rejected = reviewPatches([{ id: refund.id, tags: ["unconfirmed"], funding: "Assets:OtherWallet" }]);
  const later: ReviewPatches = new Map([[refund.id, (tx) => ({ tags: [...(tx.tags ?? []), "checked"], flag: "*" })]]);
  const [projected] = applyPendingReviewPatches([refund], [rejected, later]);
  assert.deepEqual(projected.tags, ["unconfirmed", "checked"]);
  assert.equal(projected.fundingAccount, "Assets:OtherWallet");
  const [rolledBack] = applyPendingReviewPatches([refund], [later]);
  assert.deepEqual(rolledBack.tags, ["refund", "checked"]);
  assert.equal(rolledBack.fundingAccount, "Assets:Wallet");
  assert.equal(rolledBack.flag, "*");
  assert.deepEqual(refund.tags, ["refund"]);
  const metadataBefore = makeDraft(projected);
  assert.deepEqual(draftDecision(rolledBack, { ...metadataBefore, reviewNote: "补充说明" }, metadataBefore),
    { id: refund.id, reviewNote: "补充说明" });
  console.log("✓ rolling back a queued edit keeps later choices and does not resubmit untouched draft fields");

  const purchase = { ...refund, id: "purchase", eventType: "expense", direction: "out", date: "2026-09-13", amount: 100,
    status: "ready", currency: "CNY", sourceTxId: "purchase-id", refundCounterpartId: refund.id } satisfies ParsedTx;
  const credit = { ...refund, eventType: "refund", date: "2026-10-02", amount: 79.35, status: "pending", currency: "CNY",
    sourceTxId: "refund-id", refundCounterpartId: purchase.id } satisfies ParsedTx;
  const expense = { ...purchase, amount: 0.30 };
  const allocations = [{ account: "Expenses:Food", amount: "0.10" }, { account: "Expenses:Snacks", amount: "0.20" }];
  const expensePlan = planCategoryAllocations(expense, allocations);
  assert.equal(expensePlan.remaining, 0n);
  assert.deepEqual(expensePlan.postings?.map(({ amount }) => amount), [-0.30, 0.10, 0.20]);
  assert.deepEqual(savedCategoryAllocations({ ...expense, postings: expensePlan.postings }), allocations);
  assert.equal(planCategoryAllocations(expense, [{ ...allocations[0], amount: "0.10000001" }, allocations[1]]).postings, undefined);
  const income = { ...expense, direction: "in", eventType: "income" } satisfies ParsedTx;
  const incomePlan = planCategoryAllocations(income, allocations.map((part) => ({ ...part, account: part.account.replace("Expenses:", "Income:") })));
  assert.deepEqual(incomePlan.postings?.map(({ amount }) => amount), [0.30, -0.10, -0.20]);
  const signed = [{ account: "Expenses:Food", amount: "+.40" }, { account: "Expenses:Snacks", amount: "-.10" }, { account: "Expenses:Other", amount: "0" }];
  const signedExpense = planCategoryAllocations(expense, signed);
  assert.deepEqual(signedExpense.postings?.map(({ amount }) => amount), [-0.30, 0.40, -0.10, 0]);
  assert.deepEqual(savedCategoryAllocations({ ...expense, postings: signedExpense.postings })?.map(({ amount }) => amount), ["0.40", "-0.10", "0.00"]);
  const signedIncome = planCategoryAllocations(income, signed.map((part) => ({ ...part, account: part.account.replace("Expenses:", "Income:") })));
  assert.deepEqual(signedIncome.postings?.map(({ amount }) => amount), [0.30, -0.40, 0.10, 0]);
  console.log("✓ signed category allocations reconcile exactly and preserve both posting directions");
  const grouped = buildReviewRows([credit, purchase]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].amount, 20.65);
  assert.deepEqual(grouped[0].entries, [purchase, credit]);
  assert.ok(matchesReviewSearch(grouped[0], "20.65") && matchesReviewSearch(grouped[0], "refund-id"));
  assert.ok(matchesReviewFilter(grouped[0], "pending") && matchesReviewFilter(grouped[0], "ready"));
  assert.equal(buildReviewRows([purchase, { ...credit, amount: purchase.amount }])[0].amount, 0);
  assert.equal(buildReviewRows([purchase, { ...credit, fundingAccount: "Assets:OtherWallet" }]).length, 2);
  assert.equal(buildReviewRows([purchase, { ...credit, currency: "USD" }]).length, 2);
  assert.equal(buildReviewRows([{ ...purchase, fundingAccount: "" }, { ...credit, fundingAccount: "" }]).length, 2);
  assert.equal(buildReviewRows([purchase, { ...credit, postings: [{ account: "Assets:OtherWallet", amount: 79.35, currency: "CNY" }] }]).length, 2);
  console.log("✓ the review groups only same-account, same-currency refund pairs and can find either original row");

  assert.ok(matchesReviewDateRange(grouped[0], { start: purchase.date, end: purchase.date }));
  assert.ok(matchesReviewDateRange(grouped[0], { start: "", end: purchase.date }));
  assert.ok(matchesReviewDateRange(grouped[0], { start: purchase.date, end: "" }));
  assert.ok(!matchesReviewDateRange(grouped[0], { start: credit.date, end: credit.date }));
  console.log("✓ date bounds are inclusive and the grouped row keeps its displayed purchase date");

  const pendingPurchase = { ...purchase, source: "wechat", status: "pending", finalAccount: "", suggestedAccount: "Expenses:Food" } satisfies ParsedTx;
  const pendingRefund = { ...credit, source: "wechat", finalAccount: "", suggestedAccount: "" } satisfies ParsedTx;
  const missing = { ...pendingPurchase, id: "missing", suggestedAccount: "" };
  const duplicate = { ...pendingPurchase, id: "duplicate", status: "duplicate" } satisfies ParsedTx;
  const accounts = new Set(["Assets:Wallet", "Expenses:Food"]);
  const bulkRows = buildReviewRows([pendingPurchase, pendingRefund, missing, duplicate]);
  assert.deepEqual(buildBulkPostingPlan(bulkRows, accounts, new Set([pendingPurchase.id, pendingRefund.id])), {
    approvals: [{ id: pendingPurchase.id, account: "Expenses:Food", status: "ready" }],
    exclusionIds: [pendingPurchase.id, pendingRefund.id], followedRefundIds: [pendingRefund.id], needsReview: 0,
  });
  assert.deepEqual(buildBulkPostingPlan(bulkRows, accounts), {
    approvals: [{ id: pendingPurchase.id, account: "Expenses:Food", status: "ready" }],
    exclusionIds: [pendingPurchase.id, pendingRefund.id, missing.id], followedRefundIds: [pendingRefund.id], needsReview: 1,
  });
  const needsRefundReview = buildReviewRows([pendingPurchase, { ...pendingRefund, issues: [LEDGER_DUPLICATE_ISSUE] }]);
  assert.deepEqual(buildBulkPostingPlan(needsRefundReview, accounts).approvals, []);
  console.log("✓ bulk decisions honor the scope, keep paired refunds automatic, and leave unresolved rows for review");

  status = 422; nextResponse = { error: "校验未通过", details: [{ file: "fixture.bean", line: 12, message: "账户未开户" }] };
  await assert.rejects(() => api.generate("batch", 8), (error: unknown) => error instanceof ApiError && error.status === 422 && /fixture.bean:12/.test(error.message) && /账户未开户/.test(error.message));
  status = 409; nextResponse = { error: "版本已更新" };
  await assert.rejects(() => api.decide("batch", 1, []), (error: unknown) => error instanceof ApiError && error.status === 409);
  console.log("✓ stale revisions and native validation details stay visible to reviewers");
  status = 500; nextResponse = undefined;
  await assert.rejects(() => api.funding("batch", 1), (error: unknown) => error instanceof ApiError && error.temporary);
  nextResponse = { error: "账本读取失败" };
  await assert.rejects(() => api.funding("batch", 1), (error: unknown) => error instanceof ApiError && !error.temporary && error.message === "账本读取失败");
  nextResponse = new Response("<html>Upstream error: private backend stack</html>", { status: 502 });
  await assert.rejects(() => api.upload([]), (error: unknown) => error instanceof ApiError && error.temporary
    && error.message === "服务暂时不可用，请重试");
  nextResponse = new Response("<html>Unexpected page</html>", { status: 200 });
  await assert.rejects(() => api.config(), (error: unknown) => error instanceof ApiError && /请重试/.test(error.message));
  globalThis.fetch = async () => { throw new TypeError("raw network error"); };
  await assert.rejects(() => api.upload([]), (error: unknown) => error instanceof ApiError && error.temporary
    && error.message === "服务连接中断，请重试");
  console.log("✓ empty responses, proxy pages and network exceptions get friendly retry messages");
  console.log("Web contract regression passed (10 groups).");
} finally { globalThis.fetch = originalFetch; }
