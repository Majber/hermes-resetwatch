# Banked reset: official schema evidence and safety boundary

Rechecked against the current official `openai/codex` main source at commit
`67f0994b532b8740f14b5b738af7b7b2a915b1d6` (no account API call).

- [Client paths + serialized request](https://github.com/openai/codex/blob/67f0994b532b8740f14b5b738af7b7b2a915b1d6/codex-rs/backend-client/src/client/rate_limit_resets.rs)
- [Response types and snake_case enum](https://github.com/openai/codex/blob/67f0994b532b8740f14b5b738af7b7b2a915b1d6/codex-rs/backend-client/src/types.rs)
- [Official path/payload/credit fixtures](https://github.com/openai/codex/blob/67f0994b532b8740f14b5b738af7b7b2a915b1d6/codex-rs/backend-client/src/client/rate_limit_resets_tests.rs)

The official client supports explicit credit selection via
`consume_rate_limit_reset_credit_by_id`. The verified ChatGPT path is:

```http
POST https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume
Authorization: Bearer <existing access token; never printed>
ChatGPT-Account-Id: <exact current account; never printed>
Content-Type: application/json

{"redeem_request_id":"<new UUID for this operation>","credit_id":"<exact selected GET credit id>"}
```

`redeem_request_id` is required; `credit_id` is optional upstream but **always
explicit here**. No automatic selection and no retry. The same source also
supports `/api/codex/...` for its other path style; Local deliberately enables
only the exact HTTPS ChatGPT route above, not arbitrary configured hosts.

The backend response type is `{code, windows_reset}`; `code` is one of `reset`,
`nothing_to_reset`, `no_credit`, `already_redeemed`. `windows_reset` is an integer
(default 0 in official deserialization). Official tests include a `credit`
object, but the official typed response ignores it, so Local does not depend on
that optional object. GET details provides `available_count` and `credits[]`
with `id`, `reset_type`, `status`, `granted_at`, nullable `expires_at`, `title`,
`description`; only `available` + `codex_rate_limits` + unexpired rows are
selectable here. A missing expiry is displayed as no supplied date, sorted last.

This proves official client implementation support, **not** a stable public
API contract, rollout eligibility or successful live redemption for this user.
GET details has no documented guarantee of retaining consumed rows. The official
client describes the operation as reading available credits. Requiring a returned
`redeemed` row in addition to a successful consume response was a Local bug.
A live available-only list is a plausible cause of the reported symptom, not a
verified trace of the user's past POSTs (Local does not persist those responses).

A valid top-level `code: reset` and positive integer `windows_reset` confirms the
submitted operation; the optional nested `credit` is not the success envelope.
If a top-level `credit_id` or nested `credit.id` is supplied, Local requires exact
agreement with the selected ID. Missing credit IDs are allowed by the official
typed response. GET is separately validated to display observed balances/windows.
Failed readback does not undo POST confirmation: it reports confirmed consumption
with unavailable limits refresh. A missing selected row, lower balance, or changed
limits never confirms a lost/invalid POST response. An exact `redeemed` row can
confirm prior credit redemption, but never alone the success of this operation.

## Explicit flow

1. Details → **Użyj banked reset**: resolve profile+opaque group and existing ready
   token; fresh GET `/usage` and `/rate-limit-reset-credits`, no cache/refresh.
2. Show local alias + masked JWT email (opaque short identity when no email),
   profile/account key, live Session/Weekly usage and next reset times, fresh
   inventory counts. Earliest known expiry is selected; choose another actual ID
   if desired. Eligibility 0 means no execution, without guessing its cause.
3. Acknowledge irreversible credit consumption and changed 7-day Weekly schedule;
   final **Potwierdzam — nieodwracalnie użyj wybranego resetu** is the only POST.
   Changing selection clears consent. Cancel and closing Details never consume.
4. Two-minute, one-use opaque plan binds profile path, account key/id, JWT subject,
   host/route and token fingerprint, exact listed credit IDs and one generated
   UUID. Before POST re-read inventory+quotas, compare account and user metadata,
   credit availability/expiry, token and group. Never switch candidates or refresh.
5. Exactly one POST, no redirects or network/RPC mutation retry. Read back fresh
   GET usage and details on the same context. Success requires `reset`, positive
   `windows_reset` and no mismatching returned credit ID. The displayed remaining
   count and windows come from validated GET, not optimistic subtraction. Missing
   GET after confirmed POST reports success with unavailable limits refresh.
6. Timeout/unknown POST result removes Execute and reports operation uncertainty.
   Exact GET `redeemed` confirms prior redemption only, not this operation success.
   A persistent per-profile/group/credit cache marker prevents resubmitting that
   ID, even from a new plan/restart. Only a definite `nothing_to_reset`/`no_credit`
   non-consume response releases that marker for a new explicit preparation.
   Do not clear attempt guards as a retry workaround: inspect OpenAI manually.

CLI (not used against real credentials during development):

```sh
python manage.py --profile <profile> --reset-prepare=<opaque-group-key>
python manage.py --profile <profile> --reset-redeem=<opaque-group-key> --reset-plan=<opaque-plan-token> --reset-choice=<zero-based-choice> --confirm-irreversible
```

Only plugin-local cache metadata (plan/attempt fingerprints, IDs, expirations)
is written. No bearer, raw identity, exception body or auth file is serialized.
The normal `probe.py` route is unchanged except its paired build stamp. Existing
credential removal continues to use the official Hermes CLI, not these actions.

## Verification scope

One command: `python -B tests/local/test_banked_reset.py` (one offline test plus
mocked JavaScript component/transport subfixture); syntax checks only otherwise.
Synthetic inventory and responses, no real auth reads, network redemption, grant
refresh or inference. No broad suite, upstream/vendor test or live consume.
Live Electron mounting and actual API eligibility/redemption are user tests.
