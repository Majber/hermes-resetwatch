# Resetwatch Local — Majber's primary version

This fork's default branch is **`resetwatch-local`**. The version to install is
[`resetwatch-local/plugin.js`](resetwatch-local/plugin.js) together with
[`resetwatch-local/probe.py`](resetwatch-local/probe.py) and
[`resetwatch-local/manage.py`](resetwatch-local/manage.py), version **0.2.22-local.4**.
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
cp resetwatch-local/plugin.js resetwatch-local/probe.py resetwatch-local/manage.py \
  "$DESKTOP_HOME/desktop-plugins/resetwatch-local/"
```

Install under the home used to **launch Desktop**, not an unrelated bot profile.
On Windows, use the Desktop launch home's `desktop-plugins\resetwatch-local\`
folder (`$env:HERMES_HOME`, or `$env:LOCALAPPDATA\hermes` when unset), and copy the
same three files there. Back up any existing local files before replacing them.

Open **Resetwatch Local** in the sidebar or the palette command
**Resetwatch Local: Open** (`Ctrl/Cmd+Alt+Shift+R`). Desktop watches the folder;
if needed, use **Reload desktop plugins**. The standalone copy is enabled by
its default, but a previously disabled installation stays disabled; enable it
in Desktop's plugin settings if needed.

For a remote gateway, put **this probe** at that gateway's
`desktop-plugins/resetwatch-local/probe.py` with `manage.py` beside it too. The UI discovers the gateway's
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

## Add a Codex account (assisted, not automatic login)

At the top of the page expand **Dodaj konto Codex**. Enter an optional display
name, select POSIX sh/bash/zsh or PowerShell (**not cmd.exe**), then click
**Przygotuj polecenie** (or press Enter). After resolving the selected gateway's
actual profile name, Local shows a selectable command and **Kopiuj polecenie**:

```sh
hermes --profile 'default' auth add openai-codex --type oauth --label='Work'
```

The name goes to the official CLI's `--label`; an empty field omits that option.
Single-quote escaping is shell-specific, including names containing quotes or
shell metacharacters. Controls/newlines and unknown profiles/shells fail closed.
Run it yourself in a terminal on the **same gateway machine and HERMES_HOME**,
and complete the official Hermes browser/device-code login there. Never paste
OAuth codes, passwords or tokens into Resetwatch or chat. Copying a command does
**not** start a login, and closing the instructions does **not** cancel a CLI you
started separately: use Ctrl+C in that terminal or wait for its OAuth expiry.

After the CLI reports success, click **Odśwież listę po logowaniu**. This reuses
the existing whole-roster read and provider cache/backoff rules; it does not
claim that an account was added, refresh OAuth tokens, or enable disabled
providers. Check the actual account row. A separate local alias remains available
in that row's **Szczegóły / Details** and is saved under its existing `accountKey`.
Local deliberately does not infer a newly added identity or auto-assign an alias
from the display name, a similar label, or a list-position difference. Existing
aliases, removal controls and compact rows are unchanged. The command/form is
not persisted. Focus/profile switches, closing the form, duplicate clicks and
late asynchronous results are guarded; clipboard failure offers manual selection.

Use a different OpenAI account for independent quota. Signing in again to the
same account adds no quota and may revoke its older grant; the official CLI warns
about this. Local never removes duplicates automatically. Official `auth add`
can re-enable previously suppressed credential sources and can select the first
provider when none was selected; these are CLI effects, not Local config edits.

**Why assisted:** verified against the installed Hermes CLI/parser and source:
`hermes_cli/auth_commands.py` (`_codex_login`, `_add_credential`) calls the official
OAuth flow and creates an independent `manual:device_code` / `manual:loopback_pkce`
pool entry with its own label/token pair. `hermes auth add --help` confirms the
flags. The current `apps/desktop/src/contrib/plugin.ts` `PluginOs` has clipboard
and URL actions but no interactive process/terminal launcher. `shell.exec` is a
bounded command/result RPC, not an interactive login lifecycle API. The current
Providers device-code worker (`hermes_cli/web_routers/oauth.py`) still calls
`_save_codex_tokens` (singleton); the pool POST (`web_routers/ops.py`) only accepts
API keys. Neither is a safe OAuth pool-add replacement. No private bridges,
homemade OAuth server, captured terminal/login output, or core changes are used.
The official Desktop SDK reference is
<https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk>.
This is an honest manual-assistance fallback, **not one-click browser login**.

One focused offline regression for the add UI and shell argument handling:

```sh
node tests/local/codex-add-assisted.cjs
```

It uses synthetic SDK state and a dummy shell function, never the real Hermes
login, network, credential stores or inference. PowerShell escaping is asserted
but was not exercised in a PowerShell runtime; live Electron/login is not covered.

## Explicit credential removal (Codex)

In an account row open **Szczegóły / Details**, then **Usuń z puli Hermesa**.
The first click only reads local inventory. Confirmation shows the local alias,
original masked identity, profile, opaque account key and exact stable credential
IDs/source/state. Choose one entry, or all entries only for a complete,
unambiguously identified, locally owned group (maximum four entries per action).
Inherited pools, external CLI-only credentials, unknown identities/sources and
ambiguous IDs fail closed. Cancellation does not invoke the CLI or write auth.

This removes saved Hermes credentials, **not the OpenAI account or subscription**.
It cannot be undone; signing in again is required. The official
`hermes --profile <profile> auth remove openai-codex <stable-id>` handles removal
and source suppression; device-code removal may also clear the provider's saved
Hermes OAuth block. External Codex CLI files remain untouched. Local never edits
`auth.json`, config or `.env` directly. Server-side revalidation checks current
identity and inventory before every removal; local readback must show the exact
ID absent and non-target pool rows retained before success is reported. Partial
failures are disclosed, destructive requests are not retried, and the entire
roster is refreshed afterwards. Background polling remains read-only.

Focused offline regression (one test, includes mocked UI/CLI and isolated probe
metadata dispatch; no network, models or real credential removal):

```sh
python -B tests/local/test_credential_removal.py
```

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
manually copy **all three** Local runtime files again. Do not run upstream's catalog installer
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
