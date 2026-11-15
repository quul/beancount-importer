"""One JSON request on stdin, one JSON response on stdout. Never writes a cache."""
import sys

sys.dont_write_bytecode = True

import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path


def metadata(values):
    return {
        key: str(value)
        for key, value in (values or {}).items()
        if key not in ("filename", "lineno") and not key.startswith("__")
    }


def run(request):
    try:
        from beancount import loader
        from beancount.core import data
    except ImportError as exc:
        raise RuntimeError("所选 Python 未安装 Beancount，请选择账本的 venv/bin/python") from exc

    if request.get("operation") not in ("inspect", "validate"):
        raise ValueError("operation must be inspect or validate")
    if ("file" in request) == ("text" in request):
        raise ValueError("provide exactly one of file or text")
    if "file" in request:
        filename = str(Path(request["file"]).expanduser().resolve(strict=True))
        # initialize(False) deletes existing caches. Call the uncached loader
        # directly instead, bypassing both cache reads and cache writes.
        entries, errors, _ = loader._uncached_load_file(filename, None, None, None)
    else:
        entries, errors, _ = loader.load_string(request["text"])

    diagnostics = [
        {"file": error.source.get("filename"), "line": error.source.get("lineno"), "message": error.message, "type": type(error).__name__}
        for error in errors
    ]
    result = {"ok": not diagnostics, "loader": "beancount-native", "errors": diagnostics}
    if request["operation"] == "validate":
        return result

    accounts = {}
    closed = {entry.account: str(entry.date) for entry in entries if isinstance(entry, data.Close)}
    transactions = []
    payees = defaultdict(Counter)
    for entry in entries:
        if isinstance(entry, data.Open):
            currencies = entry.currencies or []
            account = {"account": entry.account, "type": entry.account.split(":", 1)[0].lower(), "openedAt": str(entry.date), "currencies": currencies, "metadata": metadata(entry.meta)}
            if len(currencies) == 1:
                account["currency"] = currencies[0]
            if entry.account in closed:
                account["closedAt"] = closed[entry.account]
            accounts[entry.account] = account
        elif isinstance(entry, data.Transaction):
            # Pads are computed history adjustments, never source transactions.
            if entry.flag == "P" or entry.meta.get("__automatic__"):
                continue
            meta = metadata(entry.meta)
            file = entry.meta.get("filename", "<string>")
            line = entry.meta.get("lineno", 0)
            identity = f"{file}:{line}:{entry.date}"
            tx = {
                "id": "ledger-" + hashlib.sha256(identity.encode()).hexdigest()[:20],
                "date": str(entry.date), "payee": entry.payee or "", "narration": entry.narration or "",
                "postings": [
                    {"account": posting.account, "amount": float(posting.units.number), "currency": posting.units.currency}
                    for posting in entry.postings if posting.units is not None and posting.units.number is not None
                ],
                "file": file, "line": line, "flag": entry.flag, "tags": sorted(entry.tags), "links": sorted(entry.links), "metadata": meta,
            }
            for target, keys in {"time": ("time",), "source": ("source", "import-source"), "sourceTxId": ("source-tx-id", "import-id", "source_tx_id", "sourceTxId")}.items():
                for key in keys:
                    if key in meta:
                        tx[target] = meta[key]
                        break
            transactions.append(tx)
            categories = {p["account"] for p in tx["postings"] if p["account"].startswith(("Expenses:", "Income:"))}
            # A split salary or mixed purchase is not evidence for one category.
            if len(categories) == 1:
                payee = tx["payee"] or tx["narration"]
                if payee:
                    payees[payee][next(iter(categories))] += 1

    result.update({"accounts": list(accounts.values()), "transactions": transactions, "payeeIndex": {payee: [{"account": account, "count": count} for account, count in counts.most_common()] for payee, counts in payees.items()}})
    return result


if __name__ == "__main__":
    try:
        print(json.dumps(run(json.load(sys.stdin)), ensure_ascii=False, allow_nan=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "fatal": str(exc), "loader": "beancount-native", "errors": [{"type": type(exc).__name__, "message": str(exc)}]}, ensure_ascii=False))
        sys.exit(1)
