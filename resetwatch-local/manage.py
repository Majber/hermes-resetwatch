"""Explicit opt-in Hermes pool management. Default probe/polling never calls remove.

Only the official CLI writes credentials. Inventory and readback are local reads;
CLI stdout/stderr and raw credential rows never cross the plugin boundary.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ID = re.compile(r"[a-f0-9]{6,64}")
MAX_ENTRIES = 4  # Bound headless CLI time below shell.exec's 30-second limit.


def _rows(probe):
    # Deliberately no global-pool fallback: never delete another profile's pool.
    home = probe._profile_home
    if home is None:
        raise ValueError("Profil nie został jednoznacznie ustalony.")
    store = probe._read_auth_store(home / "auth.json")
    pool = store.get("credential_pool", {}) if isinstance(store, dict) else {}
    rows = pool.get("openai-codex") if isinstance(pool, dict) else None
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ValueError("Brak własnej puli profilu; odziedziczone wpisy są tylko do odczytu.")
    return rows


def _revision(rows):
    # Includes identity/token changes without disclosing either. Not an auth token.
    return hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()


def plan(probe, key):
    if not re.fullmatch(r"[a-f0-9]{20}", key):
        raise ValueError("Nieprawidłowy identyfikator konta.")
    rows = _rows(probe)
    matches = [a for a in probe._codex_pool_accounts() if a["key"] == key]
    if len(matches) != 1 or not matches[0].get("account_id"):
        raise ValueError("Tożsamość konta nie jest jednoznaczna. Nic nie usunięto.")
    account = matches[0]
    entries = []
    for candidate in account["candidates"]:
        row = candidate["entry"]
        entry_id = str(row.get("id") or "")
        source = str(row.get("source") or "")
        # Only known pool sources whose official removal does not edit config/.env
        # or another application's files. Synthetic codex-cli is not a pool ID.
        if (not ID.fullmatch(entry_id) or entry_id.isdigit()
                or source not in {"manual", "device_code", "manual:device_code"}):
            continue
        local = [r for r in rows if r.get("id") == entry_id]
        if len(local) != 1 or local[0] != row:
            continue
        entries.append({"id": entry_id, "source": source, "state": candidate["state"]})
    if not entries or len(entries) > MAX_ENTRIES:
        raise ValueError("Brak bezpiecznie identyfikowalnych wpisów (limit: 4). Użyj Hermes CLI.")
    if len({r["id"] for r in entries}) != len(entries):
        raise ValueError("Niejednoznaczne identyfikatory wpisów.")
    # An all-account option is safe only for the complete, locally owned group.
    return {"account_key": key, "entries": entries, "revision": _revision(rows),
            "all_allowed": len(entries) == len(account["candidates"]),
            "local_build": probe.LOCAL_BUILD if hasattr(probe, "LOCAL_BUILD") else "fixture"}


def _cli_path(home):
    base = home.parent.parent if home.parent.name == "profiles" else home
    for candidate in (base / "hermes-agent/.hermes/bin/hermes", base / "hermes-agent/.venv/bin/hermes"):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    found = shutil.which("hermes")
    if not found:
        raise ValueError("Nie znaleziono obsługiwanego Hermes CLI.")
    return found


def _run_remove(home, entry_id):
    profile = home.name if home.parent.name == "profiles" else "default"
    env = {**os.environ, "HERMES_HOME": str(home), "PYTHONDONTWRITEBYTECODE": "1"}
    # No shell interpolation, indices, labels, refresh or token logging.
    completed = subprocess.run(
        [_cli_path(home), "--profile", profile, "auth", "remove", "openai-codex", entry_id],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env=env, timeout=5, shell=False,
    )
    return completed.returncode


def remove(probe, key, ids, revision):
    removed = []
    error = None
    try:
        current = plan(probe, key)
        if (not ids or len(ids) > MAX_ENTRIES or len(set(ids)) != len(ids)
                or any(not isinstance(i, str) or not ID.fullmatch(i) for i in ids)
                or revision != current["revision"]):
            raise ValueError("Pula zmieniła się od potwierdzenia. Otwórz potwierdzenie ponownie.")
        available = {r["id"] for r in current["entries"]}
        if not set(ids) <= available or (len(ids) > 1 and (not current["all_allowed"] or set(ids) != available)):
            raise ValueError("Wpis nie pasuje do potwierdzonego konta.")
        expected = _rows(probe)
        for entry_id in ids:
            # Re-read exact rows and recompute group identity immediately before EACH CLI call.
            latest = plan(probe, key)
            if _revision(_rows(probe)) != _revision(expected) or entry_id not in {r["id"] for r in latest["entries"]}:
                raise ValueError("Tożsamość lub pula zmieniła się. Przerwano operację.")
            try:
                code = _run_remove(probe._profile_home, entry_id)
            except Exception:
                code = -1  # A timeout may have written: always perform readback.
            after = _rows(probe)
            survivors = [r for r in expected if r.get("id") != entry_id]
            # Priority re-numbering is an official CLI side effect; all other
            # fields on every non-target credential must remain unchanged.
            normalize = lambda rows: sorted([{k: v for k, v in r.items() if k != "priority"} for r in rows], key=lambda r: str(r.get("id")))
            absent = not any(r.get("id") == entry_id for r in after)
            if absent:
                removed.append(entry_id)
            if code or not absent or normalize(after) != normalize(survivors):
                raise ValueError("Odczyt po CLI nie potwierdził pełnego, izolowanego usunięcia. Sprawdź pulę.")
            expected = after
    except Exception:
        # Never serialize subprocess/import/credential exceptions (could contain secrets).
        error = "Nie potwierdzono pełnego usunięcia; pula lub tożsamość zmieniła się albo CLI odmówiło. Odśwież i sprawdź wpisy."
    return {"ok": error is None, "removed_ids": removed,
            "partial": bool(removed) and error is not None, "error": error}


# Verified official backend-client schema, pinned in docs/banked-reset.md.
# No default probe route calls these functions; explicit manage.py CLI only.
import time
import secrets
import uuid

RESET_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
LOCAL_BUILD = '2026-10-31-banked-reset-2'
PLAN_SECONDS = 120


def _reset_context(probe, key):
    if probe._profile_home is None or not re.fullmatch(r"[a-f0-9]{20}", key):
        raise ValueError("Nieustalony profil lub konto.")
    matches = [a for a in probe._codex_pool_accounts() if a["key"] == key]
    if len(matches) != 1:
        raise ValueError("Niejednoznaczne konto.")
    account = matches[0]
    candidates = [c for c in account["candidates"] if c["state"] == "ready"]
    if not candidates or not account.get("account_id"):
        raise ValueError("Brak aktualnego poświadczenia; zaloguj się samodzielnie.")
    candidate = candidates[0]  # Never rotate or refresh grants for a mutation.
    token = candidate["token"]
    subject = probe._jwt_claims(token).get("sub")
    url = probe._codex_usage_url(account.get("base_url") or probe.CODEX_DEFAULT_BASE_URL)
    if (url != RESET_USAGE_URL or account.get("source_host") != "chatgpt.com"
            or not subject or probe._codex_token_expiring(token)
            or probe._codex_account_id_from_token(token) != account["account_id"]
            or any(probe._jwt_claims(c["token"]).get("sub") != subject for c in candidates)):
        raise ValueError("Nieobsługiwany host lub niejednoznaczna tożsamość.")
    binding = [str(probe._profile_home.resolve()), key, account["account_id"], subject, url, token]
    return {"url": url, "token": token, "account_id": account["account_id"],
            "binding": _revision(binding),
            "identity": probe._mask_email_label(probe._codex_name_from_token(token)) if "@" in probe._codex_name_from_token(token) else "konto · " + key[:8]}


def _reset_request(ctx, method, path, payload=None):
    import httpx
    # Fixed official route only. httpx defaults to zero retries; no redirects,
    # including same-host redirects, so bearer never crosses an origin boundary.
    if ctx["url"] != RESET_USAGE_URL or path not in {"/usage", "/rate-limit-reset-credits", "/rate-limit-reset-credits/consume"}:
        raise ValueError("Unsupported reset route")
    headers = {"Authorization": "Bearer " + ctx["token"], "Accept": "application/json",
               "User-Agent": "codex-cli", "ChatGPT-Account-Id": ctx["account_id"]}
    with httpx.Client(timeout=3.0, follow_redirects=False) as client:
        response = client.request(method, ctx["url"].rsplit("/", 1)[0] + path, headers=headers,
                                  **({"json": payload} if payload is not None else {}))
        response.raise_for_status()
        if response.status_code != 200:
            raise ValueError("Unexpected reset status")
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("Invalid reset response")
        return data


def _reset_read(probe, ctx):
    usage = _reset_request(ctx, "GET", "/usage")
    if usage.get("account_id") != ctx["account_id"]:
        raise ValueError("Odczyt wskazuje inne konto lub brak tożsamości.")
    details = _reset_request(ctx, "GET", "/rate-limit-reset-credits")
    if (not isinstance(details.get("credits"), list)
            or type(details.get("available_count")) is not int or details["available_count"] < 0):
        raise ValueError("Niepełny odczyt resetów.")
    ids = [c.get("id") for c in details["credits"] if isinstance(c, dict)]
    if len(ids) != len(details["credits"]) or any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("Niejednoznaczna lista resetów.")
    windows = probe._codex_windows_from_payload(usage)
    if not windows:
        raise ValueError("Brak bieżących okien limitów.")
    summary = usage.get("rate_limit_reset_credits") or {}
    applicable = summary.get("applicable_available_count")
    return {"available_count": details["available_count"],
            "applicable_available_count": applicable if type(applicable) is int and applicable >= 0 else None,
            "windows": windows, "observed_at": time.time(), "credits": details["credits"],
            "user_id": usage.get("user_id")}


def _reset_usable(probe, data):
    credits = []
    for row in data["credits"]:
        if row.get("status") != "available" or row.get("reset_type") != "codex_rate_limits":
            continue
        expiry = row.get("expires_at")
        parsed = probe._parse_dt(expiry) if expiry else None
        if expiry and (parsed is None or parsed.timestamp() <= time.time()):
            continue
        credits.append({"id": row["id"], "expires_at": expiry,
                        "title": str(row.get("title") or "Banked reset")[:80]})
    credits.sort(key=lambda row: (probe._parse_dt(row["expires_at"]).timestamp() if row["expires_at"] else float("inf"), row["id"]))
    return credits


def _reset_plan_path(probe, token):
    if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token):
        raise ValueError("Invalid plan token")
    return probe._resetwatch_cache_dir() / ("reset_plan." + token + ".json")


def prepare_reset(probe, key):
    ctx = _reset_context(probe, key)
    current = _reset_read(probe, ctx)
    usable = _reset_usable(probe, current)
    credits = [c for c in usable if not _reset_attempt_path(probe, key, c["id"]).exists()]
    result = {"account_key": key, "identity": ctx["identity"], "credits": credits,
              **{k: current[k] for k in ("available_count", "applicable_available_count", "windows", "observed_at")}}
    if not credits or current["available_count"] == 0 or current["applicable_available_count"] == 0:
        result["reason"] = ("Wcześniej wysłany reset nadal jest dostępny w GET; zabezpieczenie blokuje ponowne wysłanie tego samego ID. Sprawdź ręcznie konto OpenAI."
                            if usable and not credits else "OpenAI zgłasza 0 resetów do użycia teraz lub brak dostępnego resetu Codex. Nie ustalamy przyczyny.")
        return result
    token = secrets.token_hex(32)
    expires = time.time() + PLAN_SECONDS
    stored = {"account_key": key, "binding": ctx["binding"], "credits": credits,
              "user_id": current["user_id"], "expires_at": expires,
              "local_build": probe.LOCAL_BUILD, "redeem_request_id": str(uuid.uuid4())}
    path = _reset_plan_path(probe, token)
    # Only plugin-local cache metadata, never auth/config; no raw tokens/identity.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(stored, stream)
    return {**result, "plan_token": token, "expires_at": expires}


def _reset_attempt_path(probe, key, credit_id):
    # Stable across token rotation and new plans; uncertain attempts cannot be
    # resubmitted even after restart. Contains no bearer or raw identity.
    digest = hashlib.sha256((key + "\0" + credit_id).encode()).hexdigest()
    return probe._resetwatch_cache_dir() / ("reset_attempt." + digest)


def _invalidate_reset_cache(probe, key):
    # Old usage must not be replayed as if it were the post-consume observation.
    cache = probe._resetwatch_cache_dir()
    for name in (f"codex_result.{key}.json", f"codex_observation.{key}.json", "probe_snapshots.cli.json", "probe_snapshots.full.json"):
        try:
            (cache / name).unlink(missing_ok=True)
        except OSError:
            pass


def redeem_reset(probe, key, token, choice, confirmed=False):
    outcome = {"ok": False, "uncertain": False, "submitted": False, "code": None,
               "windows_reset": None, "credit_verified": False, "after": None,
               "consumption_confirmed": False, "response_credit_match": None,
               "reason": "plan_invalid", "message": "Nie wysłano resetu: plan wygasł lub zmieniło się konto/reset. Przygotuj ponownie; niczego nie ponowiono.",
               "error": "Plan wygasł lub zmieniło się konto/reset. Przygotuj ponownie; niczego nie ponowiono."}
    try:
        if confirmed is not True or type(choice) is not int or choice < 0:
            return outcome
        path = _reset_plan_path(probe, token)
        # Atomic one-use claim across processes/double-clicks. Claim remains after
        # crash/timeout so neither this plan nor its request ID can be resubmitted.
        claimed = path.with_suffix(".used")
        os.rename(path, claimed)
        stored = json.loads(claimed.read_text())
        ctx = _reset_context(probe, key)
        if (stored["account_key"] != key or stored["binding"] != ctx["binding"]
                or stored["local_build"] != probe.LOCAL_BUILD or time.time() >= stored["expires_at"]
                or choice >= len(stored["credits"])):
            return outcome
        selected = stored["credits"][choice]
        before = _reset_read(probe, ctx)
        if (before["user_id"] != stored["user_id"] or before["available_count"] <= 0
                or before["applicable_available_count"] == 0
                or selected not in _reset_usable(probe, before)):
            return outcome
        # Revalidate the exact profile/account/subject/token/host after live GETs.
        if _reset_context(probe, key)["binding"] != stored["binding"] or time.time() >= stored["expires_at"]:
            return outcome
        attempt = _reset_attempt_path(probe, key, selected["id"])
        fd = os.open(attempt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump({"credit_id": selected["id"], "at": time.time()}, stream)
        outcome["submitted"] = True
        outcome["uncertain"] = True
        outcome.update(reason="post_unconfirmed", message="Wynik operacji niepewny: brak jednoznacznej odpowiedzi serwera. Nie wysyłamy ponownie; sprawdź ręcznie konto OpenAI.")
        try:
            response = _reset_request(ctx, "POST", "/rate-limit-reset-credits/consume",
                                      {"redeem_request_id": stored["redeem_request_id"], "credit_id": selected["id"]})
            # Official success fields are top-level, not inside optional `credit`.
            # If the server supplies an ID, it must match the explicitly selected ID.
            ids = [response["credit_id"]] if "credit_id" in response else []
            credit = response.get("credit")
            if credit is not None and not isinstance(credit, dict):
                ids.append(None)  # Malformed optional identity is not confirmation.
            elif isinstance(credit, dict) and "id" in credit:
                ids.append(credit["id"])
            outcome["response_credit_match"] = all(i == selected["id"] for i in ids) if ids else None
            code = response.get("code")
            count = response.get("windows_reset")
            if isinstance(code, str) and code in {"reset", "nothing_to_reset", "no_credit", "already_redeemed"}:
                outcome["code"] = code
            if type(count) is int and count >= 0:
                outcome["windows_reset"] = count
        except Exception:
            pass  # A network/HTTP/parse error can occur after server-side mutation.
        try:
            after = _reset_read(probe, ctx)
            if after["user_id"] != stored["user_id"] or _reset_context(probe, key)["binding"] != stored["binding"]:
                raise ValueError("Identity changed during readback")
            outcome["after"] = {k: after[k] for k in ("available_count", "applicable_available_count", "windows", "observed_at")}
            exact = next((c for c in after["credits"] if c["id"] == selected["id"]), None)
            # Exact terminal status proves redemption, not which operation did it.
            # Missing credit/count drop/changed windows alone prove neither.
            outcome["credit_verified"] = bool(exact and exact.get("status") == "redeemed")
        except Exception:
            pass  # Readback failure cannot erase authoritative POST confirmation.
        mismatch = outcome["response_credit_match"] is False
        outcome["ok"] = (not mismatch and outcome["code"] == "reset"
                         and type(outcome["windows_reset"]) is int and outcome["windows_reset"] > 0)
        outcome["consumption_confirmed"] = outcome["ok"] or outcome["credit_verified"]
        nonconsume = not mismatch and outcome["code"] in {"nothing_to_reset", "no_credit"} and not outcome["credit_verified"]
        outcome["uncertain"] = not outcome["ok"] and not nonconsume and not (not mismatch and outcome["code"] == "already_redeemed")
        if mismatch:
            outcome.update(reason="response_credit_mismatch", message="Wynik operacji niepewny: odpowiedź serwera wskazuje inny reset niż wybrany. Nie potwierdzamy powodzenia tej operacji i nie ponawiamy jej. Sprawdź ręcznie konto OpenAI.")
        elif outcome["ok"]:
            if outcome["after"] is None:
                outcome.update(reason="reset_confirmed_refresh_unavailable", message=f"Reset potwierdzony przez OpenAI: serwer potwierdził zużycie resetu i reset {outcome['windows_reset']} okien. Odświeżenie limitów niedostępne; odśwież je ręcznie. Nie wysyłamy resetu ponownie.")
            else:
                outcome.update(reason="reset_confirmed", message=f"Reset potwierdzony przez OpenAI: {outcome['windows_reset']} okna. Zużycie resetu potwierdzone odpowiedzią serwera; bieżące limity odczytano ponownie.")
        elif outcome["credit_verified"]:
            outcome.update(reason="prior_redemption_verified", message="Odczyt potwierdza, że wybrany reset ma status redeemed (został już zużyty). Nie potwierdza to powodzenia tej konkretnej operacji. Nie wysyłamy ponownie; sprawdź ręcznie konto OpenAI.")
        elif nonconsume:
            outcome.update(reason=outcome["code"], message="OpenAI nie potwierdziło zużycia resetu: " + outcome["code"] + "." + (" Odświeżenie limitów niedostępne." if outcome["after"] is None else " Bieżący stan odczytano ponownie."))
        elif outcome["code"] == "already_redeemed":
            outcome.update(reason="already_redeemed", message="OpenAI zgłasza already_redeemed: reset był już użyty. To nie jest potwierdzenie nowego resetu w tej operacji. Nie wysyłamy ponownie.")
        if outcome["uncertain"]:
            outcome["message"] = "Wynik operacji niepewny. " + outcome["message"] if not outcome["message"].startswith("Wynik operacji niepewny") else outcome["message"]
        outcome["error"] = None if outcome["ok"] else outcome["message"]
        _invalidate_reset_cache(probe, key)
        if nonconsume:
            attempt.unlink(missing_ok=True)  # New explicit plan only for definite non-consume.
    except Exception:
        pass  # No exception strings, response bodies, bearer or auth rows in output.
    return outcome


def main():
    import argparse
    import probe
    parser = argparse.ArgumentParser(description="Explicit Resetwatch Local banked reset actions")
    parser.add_argument("--profile", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--reset-prepare")
    mode.add_argument("--reset-redeem")
    parser.add_argument("--reset-plan")
    parser.add_argument("--reset-choice", type=int)
    parser.add_argument("--confirm-irreversible", action="store_true", default=False)
    args = parser.parse_args()
    result = {"ok": False, "error": "Nie można przygotować resetu: brak świeżej tożsamości/limitów lub obsługi endpointu. Niczego nie ponawiaj automatycznie."}
    try:
        import httpx  # Dependency discovery only, no request or login.
        if probe.LOCAL_BUILD != LOCAL_BUILD:
            raise ValueError("Mismatched Local runtime files")
        probe._profile_home = probe._resolve_profile_home(args.profile)
        if probe._profile_home is None:
            raise ValueError("Unknown profile")
        os.environ["HERMES_HOME"] = str(probe._profile_home)
        if args.reset_prepare:
            result = prepare_reset(probe, args.reset_prepare)
        else:
            result = redeem_reset(probe, args.reset_redeem, args.reset_plan, args.reset_choice, args.confirm_irreversible)
    except ImportError:
        return 2  # Read-only discovery may try an installed interpreter with httpx.
    except Exception:
        pass
    print(json.dumps({**result, "local_build": LOCAL_BUILD}, separators=(",", ":"), ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
