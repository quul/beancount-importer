import assert from "node:assert/strict";
import { api, ApiError, IncompleteReviewError } from "../web/src/api.js";
import { groupBatchList } from "../web/src/batchList.js";
import { summarizeImportDirectories } from "../web/src/ImportDestinationSummary.js";
import { draftDecision, draftPostings, invalidTags, makeDraft, parseTags, validatePostingDraft } from "../web/src/ReviewEditor.js";
import { calculatePostingAmount } from "../web/src/postingCalculator.js";
import { applyPendingReviewPatches, reviewPatches, type ReviewPatches } from "../web/src/reviewChanges.js";
import { buildBulkCategoryPlan, buildBulkPostingPlan, buildReviewRows, matchesReviewDateRange, matchesReviewFilter, matchesReviewSearch, reviewCategoryOptions } from "../web/src/reviewRows.js";
import { LEDGER_DUPLICATE_ISSUE } from "../src/shared/types.js";
import { importDirectoryError, importDirectoryRule, importTarget, importTargetTemplate } from "../src/shared/import-paths.js";
import { planCategoryAllocations, savedCategoryAllocations } from "../src/shared/categoryAllocations.js";
import { mergeSource, planTransactionMerge } from "../src/shared/transactionMerge.js";
import type { ParsedAccount, ParsedTx } from "../src/shared/types.js";

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
  const reviewSessionId = "1234567890abcdef1234567890abcdef";
  await api.decide("batch/one", 7, [{ id: "row", status: "ready" }], true, reviewSessionId);
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { revision: 7, decisions: [{ id: "row", status: "ready" }], changesOnly: true, reviewSessionId });
  await api.excludeSuspected("batch/one", 7, reviewSessionId);
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { revision: 7, reviewSessionId });
  await api.undoReviewStatus("batch/one", 8, reviewSessionId);
  assert.equal(requests.at(-1)?.url, "/api/batch/batch%2Fone/undo-review-status");
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { revision: 8, reviewSessionId });
  await api.commit("batch", 8);
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { revision: 8 });
  await api.deleteBatch("batch/one", 9);
  assert.equal(requests.at(-1)?.url, "/api/batch/batch%2Fone");
  assert.equal(requests.at(-1)?.init?.method, "DELETE");
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { revision: 9 });
  console.log("✓ config is parsed; review saves, undo and commit use their expected request fields");

  assert.deepEqual(parseTags("#trip trip,checked，!bad"), ["trip", "checked", "!bad"]);
  assert.deepEqual(invalidTags("trip2026 checked.one refund/a other_tag ok-tag"), []);
  assert.deepEqual(invalidTags("中文 !invalid"), ["中文", "!invalid"]);
  console.log("✓ quick tags deduplicate and reject unsupported native tag characters");

  const refund = { id: "refund", direction: "in", amount: 8.5, currency: "CNY", fundingAccount: "Assets:Wallet", finalAccount: "Expenses:Food", flag: "!", tags: ["refund"], reviewNote: "复核" } as ParsedTx;
  const draft = makeDraft(refund);
  assert.equal(draft.flag, "!");
  assert.deepEqual(draftPostings(refund, draft).map(({ amount }) => amount), ["-8.5", "8.5"]);
  draft.split = true;
  const refundPostings = draftPostings(refund, draft);
  const refundAccounts = refundPostings.map(({ account }) => ({ account }));
  const decision = draftDecision(refund, draft, undefined, validatePostingDraft(refundPostings, refundAccounts).postings);
  assert.equal(decision.postings?.[0].amount, -8.5); assert.deepEqual(decision.tags, ["refund"]);
  const splitRefund = { ...refund, postings: decision.postings! };
  const splitNote = draftDecision(splitRefund, { ...makeDraft(splitRefund), reviewNote: "退款单已核实" }, undefined, decision.postings!);
  assert.ok(!Object.hasOwn(splitNote, "postings"));
  draft.split = false;
  assert.equal(draftDecision(splitRefund, draft).postings, null);
  const transfer = { ...refund, eventType: "transfer", fundingAccount2: "Assets:Bank" } satisfies ParsedTx;
  const note = draftDecision(transfer, { ...makeDraft(transfer), reviewNote: "核对了转账凭证" });
  assert.equal(note.reviewNote, "核对了转账凭证");
  assert.ok(!Object.hasOwn(note, "postings"));
  const reviewedTransfer = applyPendingReviewPatches([transfer], [reviewPatches([{ id: transfer.id, account: "Income:Gifts" }])])[0];
  assert.equal(reviewedTransfer.fundingAccount2, "Income:Gifts");
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
  const incomplete = { ...refund, fundingAccount: "", finalAccount: "", status: "pending" } satisfies ParsedTx;
  const selectFunding = reviewPatches([{ id: incomplete.id, funding: "Assets:Wallet" }]);
  const selectCategory = reviewPatches([{ id: incomplete.id, account: "Expenses:Food" }]);
  assert.equal(applyPendingReviewPatches([incomplete], [selectFunding, selectCategory])[0].status, "ready");
  const [withoutFunding] = applyPendingReviewPatches([incomplete], [selectCategory]);
  assert.equal(withoutFunding.status, "pending");
  assert.equal(withoutFunding.finalAccount, "Expenses:Food");
  const approve = reviewPatches([{ id: incomplete.id, status: "ready" }]);
  assert.equal(applyPendingReviewPatches([incomplete], [selectCategory, approve])[0].status, "pending");
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
  const refundPlan = planCategoryAllocations({ ...income, eventType: "refund" }, [{ account: "Income:Gifts", amount: "0.30" }]);
  assert.deepEqual(refundPlan.postings?.map(({ amount }) => amount), [0.30, -0.30]);
  const signed = [{ account: "Expenses:Food", amount: "+.40" }, { account: "Expenses:Snacks", amount: "-.10" }, { account: "Expenses:Other", amount: "0" }];
  const signedExpense = planCategoryAllocations(expense, signed);
  assert.deepEqual(signedExpense.postings?.map(({ amount }) => amount), [-0.30, 0.40, -0.10, 0]);
  assert.deepEqual(savedCategoryAllocations({ ...expense, postings: signedExpense.postings })?.map(({ amount }) => amount), ["0.40", "-0.10", "0.00"]);
  const signedIncome = planCategoryAllocations(income, signed.map((part) => ({ ...part, account: part.account.replace("Expenses:", "Income:") })));
  assert.deepEqual(signedIncome.postings?.map(({ amount }) => amount), [0.30, -0.40, 0.10, 0]);
  const gift = { ...income, id: "gift", fundingAccount: "Income:Gifts", finalAccount: "Assets:Wallet" };
  assert.deepEqual(draftPostings(gift, makeDraft(gift)).map(({ amount }) => amount), ["0.3", "-0.3"]);
  const giftPlan = planCategoryAllocations(gift, [{ account: "Assets:Wallet", amount: "0.10" }, { account: "Assets:Bank", amount: "0.20" }]);
  assert.deepEqual(giftPlan.postings?.map(({ amount }) => amount), [-0.30, 0.10, 0.20]);
  assert.deepEqual(savedCategoryAllocations({ ...gift, postings: giftPlan.postings }), [{ account: "Assets:Wallet", amount: "0.10" }, { account: "Assets:Bank", amount: "0.20" }]);
  const giftReceipt = { ...gift, finalAccount: "Expenses:Food", sourceTxId: "gift-receipt", refundCounterpartId: undefined };
  const giftExpense = { ...giftReceipt, id: "gift-expense", sourceTxId: "gift-expense", eventType: "expense" as const, direction: "out" as const };
  const giftMerge = planTransactionMerge([giftReceipt, giftExpense], new Set(["Income:Gifts", "Expenses:Food"]));
  assert.deepEqual(giftMerge.errors, []);
  assert.deepEqual(giftMerge.funds, ["Income:Gifts"]);
  assert.equal(giftMerge.skipsPosting, false);
  const savedPurpose = { ...expense, postings: expensePlan.postings };
  const savedPurposeDraft = makeDraft(savedPurpose);
  const existingPostings = draftPostings(savedPurpose, savedPurposeDraft);
  assert.deepEqual(existingPostings.map(({ account, amount }) => [account, amount]),
    [["Assets:Wallet", "-0.3"], ["Expenses:Food", "0.1"], ["Expenses:Snacks", "0.2"]]);
  assert.deepEqual(draftDecision(savedPurpose, { ...savedPurposeDraft, flag: "*" }, savedPurposeDraft, expensePlan.postings),
    { id: expense.id, flag: "*" });
  const manualFunding = [
    { ...existingPostings[0], amount: "-0.3/2" },
    { account: "Assets:Bank", amount: "-.15", currency: "cny" },
    ...existingPostings.slice(1),
  ];
  const accountChoices = manualFunding.map(({ account }) => ({ account }));
  const manualValidation = validatePostingDraft(manualFunding, accountChoices);
  assert.deepEqual(manualValidation.postings?.map(({ amount, currency }) => [amount, currency]),
    [[-0.15, "CNY"], [-0.15, "CNY"], [0.10, "CNY"], [0.20, "CNY"]]);
  assert.deepEqual(draftDecision(savedPurpose, savedPurposeDraft, savedPurposeDraft, manualValidation.postings),
    { id: expense.id, postings: manualValidation.postings });
  const invalidPosting = validatePostingDraft([...existingPostings, { account: "", amount: "", currency: "" }], accountChoices);
  assert.deepEqual(invalidPosting.errors.at(-1), { account: "请选择账户", amount: "请输入金额", currency: "请输入币种" });
  assert.equal(invalidPosting.postings, undefined);
  const differentCurrency = validatePostingDraft([{ ...existingPostings[0], currency: "USD" }, ...existingPostings.slice(1)], accountChoices);
  assert.deepEqual([...differentCurrency.imbalances].map(([currency, total]) => [currency, Number(total.toFixed(2))]),
    [["USD", -0.30], ["CNY", 0.30]]);
  assert.equal(differentCurrency.postings, undefined);
  const combined = { ...expense, fundingParts: [{ rawAccount: "信用卡", amount: 0.2 }, { rawAccount: "红包" }],
    fundingPartAccounts: ["Liabilities:Card", null] };
  const fundingDraft = draftPostings(combined, makeDraft(combined));
  assert.deepEqual(fundingDraft.map(({ account, amount, paymentMethod }) => [account, amount, paymentMethod]), [
    [expense.finalAccount, "0.3", undefined], ["Liabilities:Card", "-0.2", "信用卡"], ["", "", "红包"],
  ]);
  assert.equal(validatePostingDraft(fundingDraft, [{ account: "Liabilities:Card" }, { account: expense.finalAccount }]).postings, undefined);
  console.log("✓ saved splits reopen as manual postings and only balanced complete edits can be saved");

  assert.deepEqual(calculatePostingAmount("100/4"), { value: "25" });
  assert.deepEqual(calculatePostingAmount("100/3"), { value: "33.33" });
  assert.deepEqual(calculatePostingAmount("（100+20）÷（5-2）-3×2"), { value: "34" });
  assert.deepEqual(calculatePostingAmount("-(1.005+0)"), { value: "-1.01" });
  assert.deepEqual(calculatePostingAmount("1.23456789"), { value: "1.23456789" });
  assert.deepEqual(calculatePostingAmount("2/(3-3)"), { error: "除数不能为 0" });
  assert.deepEqual(calculatePostingAmount("2/(3-1"), { error: "请配对括号" });
  assert.deepEqual(calculatePostingAmount("2/hello"), { error: "金额或算式无效" });
  console.log("✓ posting amounts calculate with precedence, parentheses and exact two-place rounding");
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

  const flagged = { ...expense, id: "flagged", status: "pending", refundCounterpartId: undefined,
    issues: [LEDGER_DUPLICATE_ISSUE] } satisfies ParsedTx;
  const manual = applyPendingReviewPatches([flagged], [reviewPatches([{ id: flagged.id, status: "excluded" }])])[0];
  const exclusionRows = buildReviewRows([
    manual,
    { ...flagged, id: "automatic", status: "excluded", excludedReason: "支付宝余额转入余额宝" },
    { ...flagged, id: "deduplicate", status: "excluded", reviewExclusion: "deduplicate" },
    { ...flagged, id: "old", status: "excluded" },
    { ...flagged, id: "confirmed", status: "duplicate" },
    { ...flagged, id: "needs-review" },
  ]);
  const matchingIds = (filter: Parameters<typeof matchesReviewFilter>[1]) =>
    exclusionRows.filter((row) => matchesReviewFilter(row, filter)).map(({ tx }) => tx.id);
  assert.deepEqual(matchingIds("excluded"), ["flagged", "automatic", "deduplicate", "old"]);
  assert.deepEqual(matchingIds("excluded:manual"), ["flagged"]);
  assert.deepEqual(matchingIds("excluded:automatic"), ["automatic"]);
  assert.deepEqual(matchingIds("excluded:deduplicate"), ["deduplicate"]);
  assert.deepEqual(matchingIds("suspectedDuplicate"), ["needs-review"]);
  assert.deepEqual(matchingIds("duplicate"), ["confirmed"]);
  assert.ok(matchesReviewSearch(exclusionRows[1], "余额宝"));
  const [included] = applyPendingReviewPatches([manual], [reviewPatches([{ id: manual.id, status: "pending" }])]);
  assert.equal(included.reviewExclusion, undefined);
  console.log("✓ exclusion filters follow the approval action, and hide resolved rows from suspected duplicates");

  const pendingPurchase = { ...purchase, source: "wechat", status: "pending", finalAccount: "", suggestedAccount: "Expenses:Food" } satisfies ParsedTx;
  const pendingRefund = { ...credit, source: "wechat", finalAccount: "", suggestedAccount: "" } satisfies ParsedTx;
  const missing = { ...pendingPurchase, id: "missing", suggestedAccount: "" };
  const duplicate = { ...pendingPurchase, id: "duplicate", status: "duplicate" } satisfies ParsedTx;
  const accounts = new Set(["Assets:Wallet", "Expenses:Food"]);
  const bulkRows = buildReviewRows([pendingPurchase, pendingRefund, missing, duplicate]);
  assert.deepEqual(buildBulkPostingPlan(bulkRows, accounts, new Set([pendingPurchase.id, pendingRefund.id])), {
    approvals: [{ id: pendingPurchase.id, account: "Expenses:Food", status: "ready" }],
    approvalCount: 1, exclusionIds: [pendingPurchase.id, pendingRefund.id], followedRefundIds: [pendingRefund.id], reviewTargets: [],
  });
  assert.deepEqual(buildBulkPostingPlan(bulkRows, accounts), {
    approvals: [{ id: pendingPurchase.id, account: "Expenses:Food", status: "ready" }],
    approvalCount: 1, exclusionIds: [pendingPurchase.id, pendingRefund.id, missing.id], followedRefundIds: [pendingRefund.id],
    reviewTargets: [{ id: missing.id, field: "category" }],
  });
  const needsRefundReview = buildReviewRows([pendingPurchase, { ...pendingRefund, issues: [LEDGER_DUPLICATE_ISSUE] }]);
  assert.deepEqual(buildBulkPostingPlan(needsRefundReview, accounts).reviewTargets, [{ id: pendingRefund.id }]);
  console.log("✓ bulk decisions honor the scope, keep paired refunds automatic, and leave unresolved rows for review");

  const fundAccount = { account: "Income:Investment:Fund-基金收益", type: "income", openedAt: "2026-01-01", currencies: ["CNY"] } satisfies ParsedAccount;
  const foodAccount = { account: "Expenses:Food", type: "expenses" } satisfies ParsedAccount;
  const walletAccount = { account: "Assets:Wallet", type: "assets" } satisfies ParsedAccount;
  const fund = { ...pendingPurchase, id: "fund", eventType: "income", direction: "in", payee: "余额宝收益",
    refundCounterpartId: undefined, finalAccount: "", suggestedAccount: "" } satisfies ParsedTx;
  const unpaidFund = { ...fund, id: "unfunded-income", fundingAccount: "", amount: 6 };
  const unselectedFund = { ...fund, id: "unselected-income" };
  const transferRow = { ...fund, id: "internal-transfer", eventType: "transfer" } satisfies ParsedTx;
  const manualRow = { ...fund, id: "manual-income", postings: [
    { account: walletAccount.account, amount: 100, currency: fund.currency },
    { account: fundAccount.account, amount: -100, currency: fund.currency },
  ] };
  const categoryRows = buildReviewRows([fund, unpaidFund, unselectedFund, transferRow, manualRow, duplicate]);
  const categoryOptions = [fundAccount, foodAccount, walletAccount,
    { account: "Equity:Opening", type: "equity" }, { account: "Liabilities:CreditCard", type: "liabilities" },
    { ...fundAccount, account: "Income:Future", openedAt: "2026-12-01" }, { ...fundAccount, account: "Income:USD", currencies: ["USD"] }] satisfies ParsedAccount[];
  const ledgerOptions = [...categoryOptions.slice(1), fundAccount];
  assert.deepEqual(reviewCategoryOptions(pendingPurchase, ledgerOptions), ledgerOptions);
  for (const tx of [fund, transferRow, pendingRefund]) assert.deepEqual(reviewCategoryOptions(tx, ledgerOptions), categoryOptions);
  const categoryPlan = buildBulkCategoryPlan(categoryRows, categoryOptions, new Set([fund.id, unpaidFund.id, transferRow.id, manualRow.id, duplicate.id]));
  assert.deepEqual(categoryPlan.eligible.map(({ tx }) => tx.id), [fund.id, unpaidFund.id, transferRow.id]);
  assert.deepEqual(categoryPlan.options, [fundAccount, foodAccount, ...categoryOptions.slice(3, 5)]);
  assert.equal(categoryPlan.skipped, 2);
  assert.deepEqual(buildBulkCategoryPlan(categoryRows, categoryOptions).eligible.map(({ tx }) => tx.id), [fund.id, unpaidFund.id, unselectedFund.id, transferRow.id]);
  const categorized = applyPendingReviewPatches([fund, unpaidFund, unselectedFund], [
    reviewPatches(categoryPlan.eligible.map(({ tx }) => ({ id: tx.id, account: fundAccount.account }))),
  ]);
  assert.deepEqual(categorized.map(({ finalAccount, fundingAccount, status: reviewStatus }) => [finalAccount, fundingAccount, reviewStatus]), [
    [fundAccount.account, fund.fundingAccount, "ready"], [fundAccount.account, "", "pending"], ["", unselectedFund.fundingAccount, "pending"],
  ]);
  const refundable = buildBulkCategoryPlan(bulkRows, [foodAccount, fundAccount, { ...foodAccount, account: "Expenses:Old", closedAt: "2026-09-30" }],
    new Set([pendingPurchase.id, pendingRefund.id]));
  assert.deepEqual(refundable.options, [foodAccount, fundAccount]);
  console.log("✓ individual and bulk category choices accept every account type, including for transfers and refunds");

  const summary = (batchId: string, committed = false, mergedInto?: string) =>
    ({ batchId, file: batchId, createdAt: 0, revision: 1, txCount: 1, committed, mergedInto });
  const list = groupBatchList([
    summary("active"), summary("ordinary-completed", true), summary("completed-merge", true),
    summary("nested-merge", false, "active"), summary("nested-source", false, "nested-merge"),
    summary("completed-source", false, "completed-merge"), summary("deleted-source", false, "deleted-merge"),
    { ...summary("upload"), combinedFundingPending: true },
  ]);
  assert.deepEqual(list.active.map(({ batchId }) => batchId), ["active"]);
  assert.deepEqual(list.completed.map(({ batchId }) => batchId), ["ordinary-completed", "completed-merge"]);
  assert.deepEqual(list.staged.map(({ batchId }) => batchId), ["upload"]);
  assert.deepEqual(list.children.get("active")?.map(({ batchId }) => batchId), ["nested-merge"]);
  assert.deepEqual(list.children.get("nested-merge")?.map(({ batchId }) => batchId), ["nested-source"]);
  assert.deepEqual(list.deleted, ["deleted-merge"]);
  console.log("✓ ordinary and merged completed approvals share an archive; merged sources stay under their immediate approval");

  const layout = { annualLayout: true, monthlyDir: "./{year}//{month}\\{source}/{account}/" };
  assert.equal(importDirectoryError(layout.monthlyDir), undefined);
  assert.equal(importTarget(layout, "2026-11-01", "alipay", "Assets:Bank"), "2026/11/alipay/Assets_Bank/2026-11.bean");
  assert.equal(importTarget({ ...layout, annualLayout: false, monthlyDir: "" }, "2026-11-01", "alipay", "Assets:Bank"), "202611.beancount");
  assert.equal(importTargetTemplate({ ...layout, monthlyDir: "{year}/" }), "{year}/{year}-{month}.bean");
  assert.equal(importTargetTemplate({ ...layout, annualLayout: false }, "平台/{source}"), "平台/{source}/{year}{month}.beancount");
  assert.ok(importDirectoryError("../{year}"));
  console.log("✓ settings path examples share the output naming rules and support the directory template variables");

  const summaryLayout = { annualLayout: true, monthlyDir: "{year}", statementDirectories: {
    "yuebao-interest": "理财/余额宝收益", alipay: "平台/支付宝", bank: "银行/{account}",
  } };
  assert.deepEqual(importDirectoryRule(summaryLayout, "yuebao-interest"), { template: "理财/余额宝收益", kind: "yuebao-interest" });
  assert.deepEqual(importDirectoryRule({ ...summaryLayout, statementDirectories: { alipay: "平台/支付宝" } }, "yuebao-interest"),
    { template: "平台/支付宝", kind: "alipay" });
  assert.deepEqual(importDirectoryRule({ monthlyDir: "{year}" }, "yuebao-interest"), { template: "{year}" });
  const yieldRow = { ...income, id: "destination-yuebao", date: "2026-11-01", source: "alipay", status: "pending",
    rawAccount: "余额宝", note: "余额宝-2026.11.01-收益发放 · 备注" } satisfies ParsedTx;
  const alipayRow = { ...yieldRow, id: "destination-alipay", note: "其他利息", status: "ready" } satisfies ParsedTx;
  const wechatRow = { ...alipayRow, id: "destination-wechat", source: "wechat" } satisfies ParsedTx;
  const bankRow = { ...yieldRow, id: "destination-bank", source: "bank-cmb", fundingAccount: "", finalAccount: "" } satisfies ParsedTx;
  const candidates = [yieldRow, alipayRow, wechatRow, bankRow,
    { ...yieldRow, id: "destination-duplicate", status: "duplicate" } satisfies ParsedTx,
    { ...yieldRow, id: "destination-excluded", excludedReason: "交易关闭" },
    { ...yieldRow, id: "destination-foreign", requireCnySettlement: true, currency: "JPY" }];
  assert.deepEqual(Object.fromEntries(summarizeImportDirectories(summaryLayout, candidates)
    .map(([directory, group]) => [directory, [group.count, [...group.kinds]]])), {
    "理财/余额宝收益/": [1, ["yuebao-interest"]],
    "平台/支付宝/": [1, ["alipay"]],
    "银行/{account}/": [1, ["bank"]],
    "2026/": [1, []],
  });
  const mergedDestination = { ...alipayRow, id: "destination-merged", source: "merged",
    merge: { originals: [mergeSource(yieldRow), mergeSource(alipayRow)], totals: [] } } satisfies ParsedTx;
  assert.deepEqual(summarizeImportDirectories(summaryLayout, [yieldRow, alipayRow, mergedDestination]), [
    ["2026/", { count: 1, kinds: new Set(), hasDefault: true }],
  ]);
  assert.equal(summarizeImportDirectories({ monthlyDir: "" }, [wechatRow])[0][0], "");
  console.log("✓ estimated destinations count reviewable transactions, use configured directories and preserve unresolved accounts");

  status = 422;
  const reviewReminder = "请将待确认内容处理完毕后，再点击「生成预览」。";
  const reviewProblems = [{ id: "transfer", field: "category", message: "请选择转账对方账户" }];
  nextResponse = { code: "review_incomplete", error: reviewReminder, reviewProblems, errors: ["微信支付账单.xlsx:50 请选择转账对方账户"] };
  await assert.rejects(() => api.generate("batch", 8), (error: unknown) => {
    if (!(error instanceof IncompleteReviewError) || error.status !== 422 || error.message !== reviewReminder) return false;
    assert.deepEqual(error.problems, reviewProblems);
    return true;
  });
  nextResponse = { error: "校验未通过", details: [{ file: "fixture.bean", line: 12, message: "账户未开户" }] };
  await assert.rejects(() => api.generate("batch", 8), (error: unknown) => error instanceof ApiError && error.status === 422 && /fixture.bean:12/.test(error.message) && /账户未开户/.test(error.message));
  status = 409; nextResponse = { error: "版本已更新" };
  await assert.rejects(() => api.decide("batch", 1, []), (error: unknown) => error instanceof ApiError && error.status === 409);
  console.log("✓ preview review failures are concise while stale revisions and native validation details stay visible");
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
  console.log("Web contract regression passed (16 groups).");
} finally { globalThis.fetch = originalFetch; }
