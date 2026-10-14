# Upstream 0.2.22 review

Reviewed catalog-v0.2.21 d460334 -> catalog-v0.2.22 7131146.

- Codex dead/expired login cards (PR #41, partial response to our #40): Local already supports these states, plus missing grants, route-scoped grouping and vendor observation age. Preserve Local implementation.
- Status-bar popup: intentionally not adopted; user does not want quick preview outside the full page.
- i18n bundle: Local already uses Polish labels. Preserve accepted UI.
- Installer-managed Python discovery: adopted `_hermes_install_pythons` and fallback into Local probe, without auth/credential mutation.
- Ollama /api/balance and Grok parser maintenance: upstream reference updated; not transplanted into Local during this Codex-focused update.
- Upstream has not yet implemented complete vendor-observation timestamp propagation from issue #40. Local retains its existing implementation.

Upstream root/catalog and docs/UPSTREAM.md are synchronized to 0.2.22. Local lives separately in resetwatch-local/. Do not install the upstream root/catalog package to replace Local.
