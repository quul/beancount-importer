"""One JSON request on stdin, one JSON response on stdout. Never writes a cache."""
import sys

sys.dont_write_bytecode = True

import glob
import hashlib
import json
import os
import time
from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation
from pathlib import Path


def metadata(values):
    return {
        key: str(value)
        for key, value in (values or {}).items()
        if key not in ("filename", "lineno") and not key.startswith("__")
    }


def unrounded_funding(entry, interpolate):
    postings = entry.postings
    inferred = [posting for posting in postings if (posting.meta or {}).get(interpolate.AUTOMATIC_META)]
    if len(postings) < 2 or len(inferred) != 1:
        return None
    funding = inferred[0]
    if funding.units is None or not funding.account.startswith(("Assets:", "Liabilities:")):
        return None
    currency = funding.units.currency
    if any(
        posting.cost is not None or posting.price is not None
        or posting.units is None or posting.units.currency != currency
        or not isinstance(posting.units.number, Decimal) or not posting.units.number.is_finite()
        for posting in postings
    ):
        return None
    exact = -sum(posting.units.number for posting in postings if posting is not funding)
    booked = funding.units.number
    tolerances = entry.meta.get("__tolerances__") or {}
    tolerance = tolerances.get(currency)
    if not tolerance or exact == booked or exact * booked <= 0 or abs(exact - booked) > tolerance:
        return None
    try:
        rounded = interpolate.quantize_with_tolerance(tolerances, currency, exact)
    except InvalidOperation:
        return None
    if rounded != booked:
        return None
    return {"account": funding.account, "amount": float(exact), "currency": currency}


def account_sources(filename, options, load_started):
    from beancount.parser import parser

    filenames = {os.path.normcase(os.path.normpath(name)): name for name in options.get("include", [])}
    if os.path.normcase(os.path.normpath(filename)) not in filenames or options.get("plugin"):
        return None

    sources = []
    for name in filenames.values():
        file = Path(name)
        try:
            content = file.read_bytes()
            stat = file.stat()
        except OSError:
            return None
        if max(stat.st_mtime_ns, stat.st_ctime_ns) > load_started:
            return None
        # A cached chart must account for every include. Glob matches and plugins can change independently.
        _, diagnostics, parsed_options = parser.parse_string(content, report_filename=name)
        if diagnostics or parsed_options.get("plugin"):
            return None
        for pattern in parsed_options.get("include", []):
            included = os.path.normpath(os.path.join(os.path.dirname(name), pattern))
            if glob.has_magic(included) or os.path.normcase(included) not in filenames:
                return None
        sources.append({"file": name, "sha256": hashlib.sha256(content).hexdigest()})
    return sources


def run(request):
    try:
        from beancount import loader
        from beancount.core import data, interpolate
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
        load_started = time.time_ns()
        entries, errors, options = loader._uncached_load_file(filename, None, None, None)
    else:
        entries, errors, options = loader.load_string(request["text"])

    diagnostics = [
        {"file": error.source.get("filename"), "line": error.source.get("lineno"), "message": error.message, "type": type(error).__name__}
        for error in errors
    ]
    result = {"ok": not diagnostics, "loader": "beancount-native", "errors": diagnostics}
    if request["operation"] == "validate":
        return result
    result["operatingCurrencies"] = options.get("operating_currency", [])
    if "file" in request and request.get("trackAccountSources") and not errors:
        sources = account_sources(filename, options, load_started)
        if sources:
            result["accountSources"] = sources

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
            unrounded = unrounded_funding(entry, interpolate)
            if unrounded:
                tx["unroundedFunding"] = unrounded
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
