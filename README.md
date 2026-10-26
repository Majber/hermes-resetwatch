# Resetwatch Local — Majber's primary version

This fork's default branch is **`resetwatch-local`**. The version to install is
[`resetwatch-local/plugin.js`](resetwatch-local/plugin.js) together with
[`resetwatch-local/probe.py`](resetwatch-local/probe.py), version **0.2.22-local.3**.
It is a standalone Hermes Desktop plugin, not a Hermes core modification.

## What is different

- A compact Codex account table: one row per account identity/usage host, main
  **Session / Weekly** quotas, last vendor observation, and collapsed diagnostics.
  Extra model-specific buckets remain in expanded details, not duplicated cards.
- Unhealthy credentials remain visible: locally dead, expired and missing grants
  are not silently dropped. Duplicate eligible grants share one account check;
  unhealthy duplicates remain disclosed even after another grant succeeds.
- Credential health and quota are separate. Cached observations retain their
  timestamps; historical quota is marked. A reset in the past means **awaiting
  check**, not assumed replenishment. Generic 401 is not permanent revocation.
- Usage checks are read-only for login credentials: no OAuth renewal, auth-file
  writes, inference requests, private Hermes token resolvers or Cursor CLI launch.
  Usage/rate-limit caches may be written under `cache/resetwatch-local`.
- Polish and English labels, persistent remaining/used display choice and provider
  preferences. Opening the page does not silently re-enable disabled providers.

The plugin still supports other providers and manual clocks. For a **Codex-only**
view, open the collapsed provider controls, keep Codex enabled, and disable the
other providers. Those saved choices also limit future vendor fetches.

## Install this version

Requirements: Hermes Desktop with its plugin SDK and a gateway Python with `httpx`.
Use the existing Hermes-managed interpreter; do not install dependencies into
system Python. No JavaScript build is required.

Linux/macOS, from a checkout of this branch:

```sh
git clone --branch resetwatch-local https://github.com/Majber/hermes-resetwatch.git
cd hermes-resetwatch
DESKTOP_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$DESKTOP_HOME/desktop-plugins/resetwatch-local"
cp resetwatch-local/plugin.js resetwatch-local/probe.py \
  "$DESKTOP_HOME/desktop-plugins/resetwatch-local/"
```

Install under the home used to **launch Desktop**, not an unrelated bot profile.
On Windows, use the Desktop launch home's `desktop-plugins\resetwatch-local\`
folder (`$env:HERMES_HOME`, or `$env:LOCALAPPDATA\hermes` when unset), and copy the
same two files there. Back up any existing local files before replacing them.

Open **Resetwatch Local** in the sidebar or the palette command
**Resetwatch Local: Open** (`Ctrl/Cmd+Alt+Shift+R`). Desktop watches the folder;
if needed, use **Reload desktop plugins**. The standalone copy is enabled by
its default, but a previously disabled installation stays disabled; enable it
in Desktop's plugin settings if needed.

For a remote gateway, put **this probe** at that gateway's
`desktop-plugins/resetwatch-local/probe.py` too. The UI discovers the gateway's
Python and selected profile. It never falls back to the original Resetwatch
probe if the local probe is missing: an installation error is preferable to
silently losing read-only/account-status behavior.

### Names and packaging

ID/folder: `resetwatch-local`; page: `/resetwatch-local`; cache namespace:
`resetwatch-local`. Original Resetwatch is a separate plugin with separate
settings. Disable the original in Desktop if you want only the Local page.

**Do not install the root `plugin.js` / `probe.py` or `catalog/` for this version.**
They are upstream reference files (catalog 0.2.25 plus current main) and retain
the original identity. We deliberately keep Local in its own directory to avoid
mixing it with upstream's catalog/updater packaging. This fork does not publish
a Local catalog package yet. [The historical upstream README](docs/UPSTREAM.md)
is reference material, not these installation instructions.

## Data and limitations

The probe reads existing Hermes/CLI credentials and calls vendor usage endpoints.
It does not exchange refresh tokens, sign in, or consume inference quota. APIs
are best-effort and can fail or change. Account rows identify subscriptions,
**not which credential a chat session is currently using**: the supported
Desktop SDK/RPC does not expose a per-session credential ID.

Checks run on the existing five-minute page/query cadence, with the existing
manual-refresh floor and provider backoff; there is no new background poller.
A fresh check can still return unavailable, rate-limited or cached information.
Expanded diagnostics explain the difference between inspection, attempt and
last successful observation. No tokens are printed by the probe.

## Updates are manual

There is **no in-app updater or automatic upstream update in Local**. `main`
retains upstream history; `upstream` is the original repository remote.
Local started from **`d460334db633fbaa91f0f8b96679e8463bad2a04`** (catalog 0.2.21).
The reference tree now incorporates catalog 0.2.25 (`248af31`) and upstream main
(`5b6c9c6`), without replacing Local's source/UI with the reference implementation.
Local deliberately adopts PR54 shell-path validation and PR55 Grok host pinning;
only exact Hermes interpreter variable tokens expand, not configured paths.
Shell session fallback requires an explicit extra `session_id` field rejection;
timeouts, missing parameters and authentication failures are never retried bare.
Local's captured source hashes are in
[`resetwatch-local/SNAPSHOT.json`](resetwatch-local/SNAPSHOT.json).

Codex keys and saved aliases remain unchanged for each host/account with at most
one known JWT subject. Only a real collision between distinct workspace members
splits that identity into subject-scoped rows. Ambiguous old aliases and historical
quota remain stored under the old key but are not assigned to any split member;
set a new alias for each member in that exceptional case. JWT claims are grouping
metadata only, not authentication validation. No alias/settings migration is run.

Review upstream changes before adopting them. `git fetch upstream` does not
change Local. Merge/cherry-pick only deliberately, then rerun Local tests and
check credential safety. To update an installation, review/pull this branch and
manually copy **both** Local files again. Do not run upstream's catalog installer
or updater as a shortcut.

## Focused tests

Tests use synthetic `.invalid` account labels, temporary homes/caches and mocked
vendor responses. The Python suite blocks unmocked network/subprocess access.
No test needs real credentials or the installed plugin.

```sh
# In an isolated test virtualenv:
python -m pip install httpx==0.28.1
python -m unittest discover -s tests/local -p 'test_*.py' -v
node tests/local/ui.cjs
node tests/local/compact.cjs
node --check resetwatch-local/plugin.js
python -m py_compile resetwatch-local/probe.py
```

Optional real-browser fixture layout check (Playwright/Chromium required):

```sh
TEST_TMP="$(mktemp -d "${TMPDIR:-$PWD}/resetwatch-test.XXXXXX")"
export RESETWATCH_FIXTURE_HTML="$TEST_TMP/compact.html"
node tests/local/compact.cjs
# Install Playwright into a scratch dependency directory, not this repo.
npm install --prefix "$TEST_TMP" --no-package-lock playwright@1.61.1
NODE_PATH="$TEST_TMP/node_modules" "$TEST_TMP/node_modules/.bin/playwright" install chromium
NODE_PATH="$TEST_TMP/node_modules" node tests/local/layout.cjs
rm -rf "$TEST_TMP"
```

The fixture checks seven collapsed rows, row height, and narrow horizontal
scrolling. It does not claim live Electron mounting. Root tests/workflows exercise
the retained upstream distribution; `tests/local/` exercises Local.

## License and provenance

MIT; see [LICENSE](LICENSE). Based on
[Adolanium/hermes-resetwatch](https://github.com/Adolanium/hermes-resetwatch).
This community fork is not affiliated with Nous Research or vendor services.
Only source code, synthetic tests and documentation belong here: never add
real account lists, auth/config files, secret caches or tokens.
