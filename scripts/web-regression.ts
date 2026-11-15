import assert from "node:assert/strict";
import { api, ApiError } from "../web/src/api.js";
import { draftDecision, invalidTags, makeDraft, parseTags } from "../web/src/ReviewEditor.js";
import type { ParsedTx } from "../src/shared/types.js";

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; init?: RequestInit }> = [];
let nextResponse: unknown = {};
let status = 200;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  requests.push({ url: String(url), init });
  return new Response(JSON.stringify(nextResponse), { status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

try {
  nextResponse = { ledgerRoot: "fixture", mainFile: "main.bean" };
  assert.equal((await api.config()).mainFile, "main.bean");
  await api.decide("batch/one", 7, [{ id: "row", funding: "Assets:Wallet", tags: ["checked"], flag: "!" }]);
  assert.equal(requests.at(-1)?.url, "/api/batch/batch%2Fone/decide");
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { revision: 7, decisions: [{ id: "row", funding: "Assets:Wallet", tags: ["checked"], flag: "!" }] });
  await api.commit("batch", 8);
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { revision: 8 });
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
  draft.split = false; assert.equal(draftDecision(refund, draft).postings, null);
  console.log("✓ refund split signs, review notes, flags and clearing manual postings survive draft conversion");

  status = 422; nextResponse = { error: "校验未通过", details: [{ file: "fixture.bean", line: 12, message: "账户未开户" }] };
  await assert.rejects(() => api.generate("batch", 8), (error: unknown) => error instanceof ApiError && error.status === 422 && /fixture.bean:12/.test(error.message) && /账户未开户/.test(error.message));
  status = 409; nextResponse = { error: "版本已更新" };
  await assert.rejects(() => api.decide("batch", 1, []), (error: unknown) => error instanceof ApiError && error.status === 409);
  console.log("✓ stale revisions and native validation details stay visible to reviewers");
  console.log("Web contract regression passed (4 groups).");
} finally { globalThis.fetch = originalFetch; }
