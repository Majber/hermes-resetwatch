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
