/**
 * Resetwatch: remaining subscription quota and reset clocks for Hermes Desktop.
 *
 * One uncompiled plugin.js. A full page (sidebar + palette +
 * keybind), not a HUD. Live rows come from gateway RPCs plus probe.py
 * for CLI and app logins Hermes does not OAuth itself.
 * Manual clocks cover plans with no public remaining-quota API.
 *
 * 1. Import the SDK as a namespace so missing named exports cannot crash load.
 * 2. No hardcoded colours. Five-minute polling; reset-triggered reads obey 60s floor.
 * 3. No cookies, no scrape, no composer chip, no status bar, no right pane.
 */

import * as sdk from '@hermes/plugin-sdk'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'resetwatch-local'
const PLUGIN_NAME = 'Resetwatch Local'
const ROUTE = '/resetwatch-local'
const VERSION = '0.2.22-local.4'
// Update all stamped runtime files together when deploying a paired build.
const LOCAL_BUILD = '2026-10-31-codex-add-assisted-1'
const POLL_MS = 5 * 60 * 1000
// Manual Refresh floor. probe.py enforces the same 60s on --fresh, so a
// click inside this window would only replay the cache anyway.
const REFRESH_COOLDOWN_MS = 60 * 1000
const RESET_BUFFER_MS = 5000
// Attempt keys survive remounts, but timers exist only while the page is mounted.
const resetRefreshAttempts = new Set()

const host = sdk.host
const {
  useValue,
  atom,
  useQuery,
  queryClient,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  PALETTE_AREA,
  KEYBINDS_AREA,
  Badge,
  haptic
} = sdk

const text = {
  primary: 'var(--ui-text-primary)',
  secondary: 'var(--ui-text-secondary)',
  tertiary: 'var(--ui-text-tertiary)',
  quaternary: 'var(--ui-text-quaternary)',
  red: 'var(--ui-red)',
  yellow: 'var(--ui-yellow)',
  green: 'var(--ui-green)',
  accent: 'var(--ui-accent)'
}

// Native popup options do not reliably inherit the select's painted surface.
// --ui-bg-primary is a translucent fill, not a popup surface. Keep both the
// closed control and every option on the opaque themed elevated surface.
const nativeOptionStyle = { color: text.primary, backgroundColor: 'var(--ui-bg-elevated, Canvas)' }
const nativeSelectStyle = { ...nativeOptionStyle, colorScheme: 'inherit', fontSize: '0.8125rem',
  border: '1px solid var(--ui-stroke-secondary)', borderRadius: 4, padding: '2px 6px' }

const PRESETS = [
  { id: 'cursor', name: 'Cursor', url: 'https://cursor.com/dashboard/spending' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/settings/usage' },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com' },
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app' },
  { id: 'grok', name: 'Grok', url: 'https://grok.com' },
  { id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai' },
  { id: 'custom', name: 'Custom', url: '' }
]

let storage = null
let os = null

const $clocks = atom([])
const $now = atom(Date.now())
const $missingState = atom(null)
const $providerPreferences = atom({ disabled: [], order: [] })
const $displayMode = atom('remaining')
const $accountAliases = atom({})
const ALIAS_STORAGE_KEY = 'account_aliases'
const ALIAS_MAX_LENGTH = 80
const ACCOUNT_SORT_STORAGE_KEY = 'account_sort'
const ACCOUNT_SORT_KEYS = ['default', 'session', 'weekly', 'reset', 'state']
const $accountSortPreferences = atom({})
const VIEW_MODE_STORAGE_KEY = 'view_modes'
const $viewModes = atom({})

function viewModeFor(connectionId, profile) {
  return $viewModes.get()[accountSortScope(connectionId, profile)] === 'codex' ? 'codex' : 'all'
}

function loadViewModes() {
  try {
    const raw = stored(VIEW_MODE_STORAGE_KEY, {})
    $viewModes.set(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})
  } catch { $viewModes.set({}) }
}

function saveViewMode(connectionId, profile, value) {
  if (!storage || connectionId === null) return false
  try {
    const raw = storage.get(VIEW_MODE_STORAGE_KEY, {})
    const next = { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
      [accountSortScope(connectionId, profile)]: value === 'codex' ? 'codex' : 'all' }
    storage.set(VIEW_MODE_STORAGE_KEY, next)
    if (JSON.stringify(storage.get(VIEW_MODE_STORAGE_KEY, null)) !== JSON.stringify(next)) return false
    $viewModes.set(next)
    return true
  } catch { return false }
}

function normalizeAccountSort(raw) {
  const key = ACCOUNT_SORT_KEYS.includes(raw && raw.key) ? raw.key : 'default'
  return { key, direction: raw && ['asc', 'desc'].includes(raw.direction) ? raw.direction : ['session', 'weekly'].includes(key) ? 'desc' : 'asc' }
}

function accountSortScope(connectionId, profile) {
  return JSON.stringify([connectionId, profile || 'default'])
}

function accountSortFor(connectionId, profile) {
  return normalizeAccountSort($accountSortPreferences.get()[accountSortScope(connectionId, profile)])
}

function loadAccountSortPreferences() {
  try {
    const raw = stored(ACCOUNT_SORT_STORAGE_KEY, {})
    $accountSortPreferences.set(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})
  } catch { $accountSortPreferences.set({}) }
}

function saveAccountSort(connectionId, profile, value) {
  if (!storage || connectionId === null) return false
  try {
    const raw = storage.get(ACCOUNT_SORT_STORAGE_KEY, {})
    const next = { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
      [accountSortScope(connectionId, profile)]: normalizeAccountSort(value) }
    storage.set(ACCOUNT_SORT_STORAGE_KEY, next)
    const saved = storage.get(ACCOUNT_SORT_STORAGE_KEY, null)
    if (JSON.stringify(saved) !== JSON.stringify(next)) return false
    $accountSortPreferences.set(next)
    return true
  } catch { return false }
}

function sortAccounts(accounts, selected, nowMs) {
  const { key, direction } = normalizeAccountSort(selected)
  const entries = [...accounts]
  if (key === 'default') return entries
  const stateRank = { available: 0, limit_reached: 1, pending: 2, stale: 3, historical: 4, unknown: 5 }
  const value = snap => {
    const status = deriveAccountStatus(snap, nowMs)
    if (key === 'state') return stateRank[status.freshness === 'fresh' ? status.availability : status.freshness] ?? 5
    // Historical or unknown observations cannot rank as live remaining quota/reset.
    if (status.historical) return null
    const windows = mainQuotaWindows(snap)
    if (key === 'reset') {
      const future = windows.map(window => Date.parse(window.reset_at)).filter(ms => Number.isFinite(ms) && ms > nowMs)
      return future.length ? Math.min(...future) : null
    }
    const window = windows.find(item => String(item.label).toLowerCase() === (key === 'session' ? 'session' : 'weekly'))
    return window ? quotaPercent({ remaining: window.remaining_percent, used: window.used_percent }, 'remaining') : null
  }
  return entries.map((entry, index) => {
    const status = deriveAccountStatus(entry[1].snap, nowMs)
    return { entry, index, value: value(entry[1].snap),
      // Weekly exhaustion blocks use even when the session allowance is full.
      blocked: key === 'session' && status.availability === 'limit_reached' ? 1 : 0 }
  })
    .sort((a, b) => a.value === null && b.value !== null ? 1 : b.value === null && a.value !== null ? -1
      : a.blocked !== b.blocked ? a.blocked - b.blocked
      : a.value === b.value ? a.index - b.index : (a.value - b.value) * (direction === 'desc' ? -1 : 1))
    .map(item => item.entry)
}

function AccountSortControls({ connectionId, profile }) {
  const t = useLocalText()
  useValue($accountSortPreferences)
  const selected = accountSortFor(connectionId, profile)
  const [failed, setFailed] = useState(false)
  const save = next => setFailed(!saveAccountSort(connectionId, profile, next))
  return jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 4 }, children: [
    jsxs('select', { 'aria-label': t('sortAccounts'), title: t('sortHelp'), value: selected.key,
      disabled: connectionId === null,
      onChange: event => save(normalizeAccountSort({ key: event.target.value })),
      style: nativeSelectStyle,
      children: ACCOUNT_SORT_KEYS.map(key => jsx('option', { value: key, style: nativeOptionStyle, children: t(`sort_${key}`) }, key)) }),
    jsx(SmallButton, { disabled: connectionId === null || selected.key === 'default', title: t(selected.direction === 'asc' ? 'ascending' : 'descending'),
      onClick: () => { const current = accountSortFor(connectionId, profile); save({ ...current, direction: current.direction === 'asc' ? 'desc' : 'asc' }) },
      children: selected.direction === 'asc' ? '↑' : '↓' }),
    failed ? jsx('span', { role: 'alert', title: t('sortError'), style: { fontSize: '0.6875rem', color: text.red }, children: t('sortError') }) : null
  ] })
}

function normalizeAccountAliases(raw) {
  return Object.fromEntries(Object.entries(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})
    .filter(([key, value]) => key && typeof value === 'string' && value.trim())
    .map(([key, value]) => [key, value.trim().slice(0, ALIAS_MAX_LENGTH)]))
}

function loadAccountAliases() {
  try { $accountAliases.set(normalizeAccountAliases(stored(ALIAS_STORAGE_KEY, {}))) }
  catch { $accountAliases.set({}) }
}

function saveAccountAlias(accountKey, value) {
  if (!storage || !accountKey) return false
  const alias = String(value || '').trim().slice(0, ALIAS_MAX_LENGTH)
  try {
    // Read the current namespace, not a render closure; preserve other accounts.
    const next = normalizeAccountAliases(storage.get(ALIAS_STORAGE_KEY, {}))
    if (alias) next[accountKey] = alias
    else delete next[accountKey]
    storage.set(ALIAS_STORAGE_KEY, next)
    // The SDK's best-effort set can silently fail. Confirm before updating UI.
    const saved = storage.get(ALIAS_STORAGE_KEY, null)
    if (!saved || JSON.stringify(saved) !== JSON.stringify(next)) return false
    $accountAliases.set(next)
    return true
  } catch { return false }
}

function stored(key, fallback) {
  return storage ? storage.get(key, fallback) : fallback
}

function remember(key, value) {
  if (storage) storage.set(key, value)
}

function loadClocks() {
  const raw = stored('clocks', [])
  const list = Array.isArray(raw) ? raw : []
  $clocks.set(
    list.filter(
      clock =>
        clock &&
        typeof clock.id === 'string' &&
        typeof clock.name === 'string' &&
        clampPercent(clock.remaining) !== null
    )
  )
}

function saveClocks(next) {
  $clocks.set(next)
  remember('clocks', next)
}

function tap() {
  if (typeof haptic === 'function') haptic('tap')
}

function clampPercent(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, Math.round(n)))
}

function remainingFromUsed(used) {
  const usedPct = clampPercent(used)
  if (usedPct === null) return null
  return Math.max(0, 100 - usedPct)
}

function normalizeDisplayMode(value) {
  return value === 'used' ? 'used' : 'remaining'
}

function saveDisplayMode(value) {
  const mode = normalizeDisplayMode(value)
  $displayMode.set(mode)
  remember('display_mode', mode)
}

function quotaPercent(card, mode) {
  return normalizeDisplayMode(mode) === 'used'
    ? clampPercent(card.used) ?? remainingFromUsed(card.remaining)
    : clampPercent(card.remaining) ?? remainingFromUsed(card.used)
}

function toneForRemaining(remaining) {
  if (remaining === null || remaining === undefined) return 'ok'
  if (remaining <= 10) return 'bad'
  if (remaining <= 30) return 'warn'
  return 'ok'
}

function toneColor(tone) {
  if (tone === 'bad') return text.red
  if (tone === 'warn') return text.yellow
  return text.secondary
}

function formatReset(resetAt, resetText, nowMs, t = localText()) {
  if (resetText) return resetText
  if (!resetAt) return ''
  const date = new Date(resetAt)
  if (Number.isNaN(date.getTime())) return String(resetAt)
  const delta = date.getTime() - (nowMs || Date.now())
  const local = date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
  if (delta <= 0) return `${t('resetPending')} · ${local}`
  const minutes = Math.round(delta / 60000)
  if (minutes < 1) return `${t('resetNow')} · ${local}`
  if (minutes < 60) return `${t('resetIn')} ${minutes} min · ${local}`
  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  if (hours < 24) return `${t('resetIn')} ${hours} h ${rem} min · ${local}`
  const days = Math.floor(hours / 24)
  return `${t('resetIn')} ${days} d ${hours % 24} h · ${local}`
}

function toDatetimeLocal(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fromDatetimeLocal(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function isNousProvider(name) {
  return /^nous\b/i.test(String(name || '').trim())
}

function providerKey(name) {
  const key = String(name || '').trim().toLowerCase()
  if (key === 'claude') return 'anthropic'
  if (key === 'codex') return 'openai-codex'
  if (isNousProvider(key)) return 'nous'
  if (key === 'kimi-coding') return 'kimi'
  if (key === 'xai-oauth' || key === 'xai') return 'grok'
  if (key === 'zai' || key === 'zcode' || key === 'zhipu' || key === 'glm-coding' || key === 'zai-coding-plan') return 'glm'
  if (key === 'deep-seek') return 'deepseek'
  if (key === 'opencode_go' || key === 'opencode-go-sub' || key === 'go') return 'opencode-go'
  if (key === 'ollama-cloud' || key === 'ollama_cloud') return 'ollama'
  if (key === 'minimax-cn' || key === 'minimax_cn' || key === 'minimax-token-plan') return 'minimax'
  if (key === 'novita-ai' || key === 'novitaai') return 'novita'
  if (key === 'deep-infra') return 'deepinfra'
  if (key === 'ai-gateway' || key === 'vercel' || key === 'vercel-ai-gateway') return 'ai-gateway'
  return key
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim())
}

function newClockId() {
  return `clock:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
}

function errorMessage(error, fallback) {
  if (typeof error === 'string' && error && error !== '[object Object]') return error
  if (error && typeof error.message === 'string' && error.message && error.message !== '[object Object]') {
    return error.message
  }
  return fallback
}

const PROVIDER_LABELS = {
  anthropic: 'Claude',
  'openai-codex': 'Codex',
  openrouter: 'OpenRouter',
  cursor: 'Cursor',
  kimi: 'Kimi',
  'kimi-coding': 'Kimi',
  grok: 'Grok',
  'xai-oauth': 'Grok',
  xai: 'Grok',
  glm: 'GLM',
  zai: 'GLM',
  zcode: 'GLM',
  zhipu: 'GLM',
  'zai-coding-plan': 'GLM',
  deepseek: 'DeepSeek',
  'deep-seek': 'DeepSeek',
  'opencode-go': 'OpenCode Go',
  opencode_go: 'OpenCode Go',
  go: 'OpenCode Go',
  ollama: 'Ollama Cloud',
  'ollama-cloud': 'Ollama Cloud',
  ollama_cloud: 'Ollama Cloud',
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax',
  novita: 'Novita',
  'novita-ai': 'Novita',
  deepinfra: 'DeepInfra',
  'deep-infra': 'DeepInfra',
  'ai-gateway': 'AI Gateway',
  vercel: 'AI Gateway',
  'vercel-ai-gateway': 'AI Gateway',
  commandcode: 'Command Code',
  nous: 'Nous'
}

const LIVE_PROVIDERS = [
  'nous', 'anthropic', 'openai-codex', 'openrouter', 'cursor', 'kimi', 'grok',
  'glm', 'deepseek', 'opencode-go', 'ollama', 'minimax', 'novita', 'deepinfra',
  'ai-gateway', 'commandcode'
]

function normalizeProviderPreferences(raw) {
  const valid = values => [...new Set((Array.isArray(values) ? values : [])
    .map(providerKey).filter(key => LIVE_PROVIDERS.includes(key)))]
  return { disabled: valid(raw && raw.disabled).sort(), order: valid(raw && raw.order) }
}

function saveProviderPreferences(next) {
  const value = normalizeProviderPreferences(next)
  remember('providers', value)
  $providerPreferences.set(value)
}

function effectiveProviderPreferences(preferences, mode) {
  return mode === 'codex'
    ? { ...preferences, disabled: LIVE_PROVIDERS.filter(key => key !== 'openai-codex').sort() }
    : preferences
}

function cardProvider(card) {
  if (String(card.id).startsWith('nous:')) return 'nous'
  return accountCardProvider(card.id) || providerKey(card.provider)
}

function arrangeProviderCards(cards, preferences) {
  const { disabled, order } = normalizeProviderPreferences(preferences)
  const rank = key => { const index = order.indexOf(key); return index < 0 ? order.length : index }
  return (cards || []).filter(card => !disabled.includes(cardProvider(card)))
    .sort((a, b) => rank(cardProvider(a)) - rank(cardProvider(b)))
}

function ProviderControls({ preferences, connectionId, profile, mode }) {
  const t = useLocalText()
  const [failed, setFailed] = useState(false)
  const codexOnly = mode === 'codex'
  const order = [...preferences.order, ...LIVE_PROVIDERS.filter(key => !preferences.order.includes(key))]
  const move = (index, delta) => {
    if (index + delta < 0 || index + delta >= order.length) return
    const next = [...order]
    const moved = next.splice(index, 1)[0]
    next.splice(index + delta, 0, moved)
    saveProviderPreferences({ ...preferences, order: next })
  }
  return jsxs('details', {
    children: [
      jsx('summary', { style: { cursor: 'pointer', color: text.secondary, fontSize: '0.75rem' }, children: t('providersHeading') }),
      jsxs('label', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', color: text.secondary, fontSize: '0.8125rem' }, children: [
        t('providerScope'),
        jsxs('select', { 'aria-label': t('providerScope'), value: mode, disabled: connectionId === null,
          style: nativeSelectStyle,
          onChange: event => setFailed(!saveViewMode(connectionId, profile, event.target.value)),
          children: [
            jsx('option', { value: 'all', style: nativeOptionStyle, children: t('allProviders') }),
            jsx('option', { value: 'codex', style: nativeOptionStyle, children: t('codexOnly') })
          ] }),
        failed ? jsx('span', { role: 'alert', style: { color: text.red }, children: t('viewModeError') }) : null
      ] }),
      jsx('p', { style: { margin: '0 0 6px', color: text.tertiary, fontSize: '0.75rem' }, children: t('viewModeHelp') }),
      jsx('p', { style: { color: text.tertiary, fontSize: '0.75rem' },
        children: t('providersHelp') }),
      ...order.map((key, index) => jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, maxWidth: 400, padding: '4px 0' },
        children: [
          jsxs('label', { style: { flex: 1, display: 'flex', gap: 8 }, children: [
            jsx('input', { type: 'checkbox', checked: !preferences.disabled.includes(key), disabled: codexOnly,
              onChange: event => saveProviderPreferences({ ...preferences,
                disabled: event.target.checked ? preferences.disabled.filter(item => item !== key) : [...preferences.disabled, key] }) }),
            PROVIDER_LABELS[key]
          ] }),
          jsx(SmallButton, { disabled: codexOnly || index === 0, title: `${t('moveUp')}: ${PROVIDER_LABELS[key]}`, onClick: () => move(index, -1), children: '↑' }),
          jsx(SmallButton, { disabled: codexOnly || index === order.length - 1, title: `${t('moveDown')}: ${PROVIDER_LABELS[key]}`, onClick: () => move(index, 1), children: '↓' })
        ]
      }, key)),
      jsx(SmallButton, { disabled: codexOnly, onClick: () => saveProviderPreferences({}), children: t('resetProviders') })
    ]
  })
}

function nousPortalTitle(planName) {
  const plan = String(planName || '').trim()
  if (!plan || /^nous(\s+portal)?$/i.test(plan)) return 'Nous Portal'
  return `Nous Portal (${plan})`
}

function providerTitle(provider, plan) {
  const key = String(provider || '').trim().toLowerCase()
  const base = PROVIDER_LABELS[key] || provider || 'Account'
  return plan ? `${base} (${plan})` : base
}

function parseUsageOutput(text) {
  const groups = []
  let current = null
  let inLimits = false
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\*\*/g, '').replace(/^📈\s*/, '').trim()
    if (!line) continue
    if (/^(account limits|nous credits)$/i.test(line)) {
      inLimits = true
      current = null
      continue
    }
    if (/^(session (token )?usage|session info|rate limits)\b/i.test(line)) {
      inLimits = false
      current = null
      continue
    }
    if (!inLimits && !/^provider:/i.test(line)) continue
    const provider = line.match(/^Provider:\s+(.+)$/i)
    if (provider) {
      inLimits = true
      current = { provider: provider[1].trim(), windows: [], details: [] }
      groups.push(current)
      continue
    }
    const windowMatch = line.match(
      /^(.+?):\s+(\d+)% remaining \((\d+)% used\)(?:\s+[•·-]\s+(.+))?$/i
    )
    if (windowMatch) {
      if (!current) {
        current = { provider: 'Account', windows: [], details: [] }
        groups.push(current)
      }
      const suffix = (windowMatch[4] || '').trim()
      const resetText = /^resets\s+/i.test(suffix) ? suffix.replace(/^resets\s+/i, '') : ''
      const detail = resetText ? '' : suffix
      current.windows.push({
        label: windowMatch[1].trim(),
        remaining: Number(windowMatch[2]),
        used: Number(windowMatch[3]),
        resetText,
        detail
      })
      continue
    }
    if (/^unavailable:/i.test(line)) continue
    if (current) current.details.push(line)
  }
  return groups
}

function remainingFromBar(bar) {
  if (!bar) return { remaining: null, used: null }
  const used = clampPercent(bar.pct_used)
  if (used !== null) return { remaining: remainingFromUsed(used), used }
  if (typeof bar.fill_fraction === 'number' && Number.isFinite(bar.fill_fraction)) {
    // Hermes fill_fraction is remaining (remaining_usd / total_usd), not consumed.
    const remaining = clampPercent(bar.fill_fraction * 100)
    return { remaining, used: remainingFromUsed(remaining) }
  }
  return { remaining: null, used: null }
}

function cardsFromUsageBars(bars) {
  if (!bars || bars.available === false) return []
  const cards = []
  const planName = nousPortalTitle(bars.plan_name)
  const pushBar = (bar, label, { showPercent = true } = {}) => {
    if (!bar) return
    const { remaining, used } = remainingFromBar(bar)
    cards.push({
      id: `nous:${label}`,
      source: 'live',
      provider: planName,
      label,
      remaining: showPercent ? remaining : null,
      used: showPercent ? used : null,
      resetAt: bars.renews_at || null,
      resetText: bars.renews_display || '',
      detail:
        bar.remaining_display && bar.total_display
          ? `${bar.remaining_display} of ${bar.total_display} left`
          : bars.subscription_remaining_display || ''
    })
  }
  pushBar(bars.plan_bar, 'Subscription')
  if (bars.has_topup) pushBar(bars.topup_bar, 'Top-up credits', { showPercent: false })
  return cards
}

function cardsFromUsageGroups(groups, skipNous) {
  const cards = []
  for (const group of groups || []) {
    if (skipNous && isNousProvider(group.provider)) continue
    const extra = (group.details || []).filter(line => !/^\(or run \/topup\)$/i.test(line))
    const windows = group.windows || []
    windows.forEach((window, index) => {
      cards.push({
        id: `usage:${group.provider}:${index}:${window.label}`,
        source: 'live',
        provider: group.provider,
        label: window.label,
        remaining: clampPercent(window.remaining),
        used: clampPercent(window.used),
        resetAt: null,
        resetText: window.resetText || '',
        detail: [window.detail, index === windows.length - 1 ? extra.join(' · ') : ''].filter(Boolean).join(' · ')
      })
    })
    if (!windows.length && extra.length) {
      cards.push({
        id: `usage:${group.provider}:note`,
        source: 'live',
        provider: group.provider,
        label: group.provider,
        remaining: null,
        used: null,
        resetAt: null,
        resetText: '',
        detail: extra.join(' · ')
      })
    }
  }
  return cards
}

function maskEmailLabel(label) {
  const text = String(label || '').trim()
  const at = text.indexOf('@')
  if (at <= 0 || at === text.length - 1 || text.includes(' ')) return text
  return `${text.slice(0, Math.min(2, at))}**${text.slice(at)}`
}

function familyTitle(provider) {
  const key = providerKey(provider)
  if (key === 'anthropic' || key === 'claude') return 'Claude'
  if (key === 'openai-codex') return 'Codex'
  return PROVIDER_LABELS[key] || String(provider || 'Account')
}

function snapshotAccountLabel(snap) {
  return maskEmailLabel(String(snap && snap.account_label ? snap.account_label : '').trim())
}

function snapshotAccountKey(snap) {
  const key = String(snap && snap.account_key ? snap.account_key : '').trim()
  if (key) return accountIdTag(key)
  return accountIdTag(snapshotAccountLabel(snap))
}

function accountIdTag(label) {
  return String(label || '').trim().replace(/:/g, '-')
}

function accountCardProvider(id) {
  const text = String(id || '')
  if (!text.startsWith('account:')) return ''
  const rest = text.slice('account:'.length)
  const colon = rest.indexOf(':')
  const provider = colon === -1 ? rest : rest.slice(0, colon)
  return providerKey(provider)
}

function observedMillis(value) {
  if (value === null || value === undefined || value === '') return null
  const stamp = typeof value === 'number' ? value * 1000 : Date.parse(value)
  return Number.isFinite(stamp) && stamp > 0 ? stamp : null
}

function mainQuotaWindows(snap) {
  return (snap.windows || []).filter(window => providerKey(snap.provider) !== 'openai-codex' || /^(Session|Weekly|30 days)$/i.test(window.label))
}

function exhaustedWindow(window) {
  return Number.isFinite(window.remaining_percent) && window.remaining_percent <= 0
    || Number.isFinite(window.used_percent) && window.used_percent >= 100
}

function resetRefreshPlan(cards, nowMs, attempted, cooldownUntil, scope = '') {
  const candidates = new Map()
  for (const card of cards || []) {
    const snap = card.snapshot
    if (!snap || providerKey(snap.provider) !== 'openai-codex' || !/^[a-f0-9]{20}$/.test(snap.account_key || '')) continue
    const observedAt = observedMillis(snap.fetched_at)
    if (!observedAt) continue
    for (const window of mainQuotaWindows(snap)) {
      const reset = Date.parse(window.reset_at)
      // Already checked after this reset, including APIs retaining old clocks.
      if (!Number.isFinite(reset) || reset <= observedAt) continue
      const key = JSON.stringify([scope, snap.account_key, observedAt, reset])
      if (attempted.has(key)) continue
      const due = Math.max(reset + RESET_BUFFER_MS, (observedMillis(snap.last_attempt_at) || observedAt) + REFRESH_COOLDOWN_MS, cooldownUntil || 0)
      candidates.set(key, due)
    }
  }
  if (!candidates.size) return null
  const at = Math.max(nowMs, Math.min(...candidates.values()))
  return { at, keys: [...candidates].filter(([, due]) => due <= at).map(([key]) => key) }
}

function mergeAccountRefresh(previous, next, accountKey) {
  const base = previous || { cards: [], errors: [] }
  const replacement = (next.cards || []).filter(card => card.accountKey === accountKey)
  if (!replacement.length) return { ...base, errors: [...(base.errors || []), ...(next.errors || [])] }
  let inserted = false
  const cards = (base.cards || []).flatMap(card => {
    if (card.accountKey !== accountKey) return [card]
    if (inserted) return []
    inserted = true
    return replacement
  })
  if (!inserted) cards.push(...replacement)
  return { ...base, cards, errors: [...(base.errors || []), ...(next.errors || [])] }
}

function deriveAccountStatus(snap, nowMs) {
  const exhausted = mainQuotaWindows(snap).filter(exhaustedWindow)
  const limited = snap.quota_state === 'limit_reached' || snap.limit_reached === true || exhausted.length > 0
  const scopes = new Set(exhausted.map(window => String(window.label).toLowerCase()).filter(label => ['session', 'weekly', '30 days'].includes(label)))
  const blockScope = !limited ? null : scopes.size === 2 && scopes.has('session') && scopes.has('weekly') ? 'both' : scopes.size === 1 ? [...scopes][0] : 'unknown'
  const resets = exhausted.map(window => Date.parse(window.reset_at))
  const recoveryAt = exhausted.length && resets.every(ms => Number.isFinite(ms) && ms > nowMs) ? Math.max(...resets) : null
  // Auth describes the last check/local inspection, never quota age or inference.
  const local = snap.credential_status
  const auth = ['expired', 'missing', 'revoked'].includes(local) ? local : snap.account_status || 'unknown'
  const observedAt = observedMillis(snap.fetched_at)
  const windows = mainQuotaWindows(snap)
  const tightest = windows.filter(window => clampPercent(window.used_percent) !== null)
    .sort((a, b) => Number(b.used_percent) - Number(a.used_percent))[0] || null
  let freshness = 'fresh'
  if (!observedAt || observedAt > nowMs + 60000) freshness = 'unknown'
  else if (windows.some(window => window.reset_at && Date.parse(window.reset_at) <= nowMs)) freshness = 'pending'
  else if (nowMs - observedAt > POLL_MS + REFRESH_COOLDOWN_MS) freshness = 'stale'
  else if (auth !== 'verified' || snap.error) freshness = 'historical'

  const availability = freshness !== 'fresh' ? 'unknown' : limited ? 'limit_reached'
    : snap.allowed === true || snap.quota_state === 'available' ? 'available' : 'unknown'
  // Keep the legacy composite state for existing historical-card consumers.
  const state = auth !== 'verified' ? auth : freshness === 'fresh' ? availability : freshness === 'historical' ? 'unknown' : freshness
  return { state, auth, freshness, availability, historical: freshness !== 'fresh' || availability === 'unknown', tightest, blockScope, recoveryAt }
}

const LOCAL_TEXT = {
  en: {
    authLabel: 'Auth', quotaLabel: 'Quota', short_verified: 'Logged in',
    verified: 'Credentials were accepted by the usage API at the last successful check; this is not a guarantee of current sign-in.',
    authHelp: 'Last usage API authentication or local credential inspection, not an inference check or a guarantee of current sign-in. Expired access tokens do not establish an invalid refresh grant.',
    fresh: 'Fresh', historical: 'Historical', short_fresh: 'Fresh', short_historical: 'Historical',
    freshnessHelp: 'Quota observation freshness is independent of authentication. Historical or unknown quota is not live availability. Fresh means observed within 6 minutes and no main reset has elapsed; cache reuse does not renew the timestamp.',
    sortAccounts: 'Sort accounts', sort_default: 'Original order', sort_session: 'Session remaining', sort_weekly: 'Weekly remaining', sort_reset: 'Nearest reset', sort_state: 'State',
    ascending: 'Ascending', descending: 'Descending', sortError: 'Sort not saved',
    sortHelp: 'Local only. Remaining sorts always use remaining %, even in Used mode. For remaining/reset sorts, historical/unknown values are last in either direction. Reset uses future main Session/Weekly timestamps from live observations. State ascending: available, limit reached, awaiting check, stale, historical, unknown; descending reverses these states. Ties retain source order; Original order preserves provider/source ordering. Saved per connection and profile.',
    available: 'Available — usage API verified', limit_reached: 'Usage limit reached',
    revoked: 'Sign in again — invalid saved grant', expired: 'Expired / expiring token — not checked',
    missing: 'Missing access token — not checked', auth_required: 'Authentication failed — renewal may help',
    forbidden: 'Access denied — cause not established', rate_limited: 'Usage API rate-limited',
    unknown: 'Unknown / check failed', pending: 'Reset elapsed — awaiting check', stale: 'Stale observation — awaiting check',
    observed: 'Last vendor observation', never: 'No successful vendor observation', cached: 'Cached',
    inspected: 'Local credentials inspected', attempted: 'Last vendor attempt', grants: 'Credential entries',
    guidance: 'Read-only: does not renew tokens or test inference. For invalid grants, use Hermes Accounts to sign in again for the intended account. Expired access tokens do not prove the refresh grant is invalid. Active-account selection is not exposed here.',
    heading: 'Account status', windows: 'Quota windows', history: 'Historical quota',
    count: 'accounts', help: 'Separate local copy. Status and quota are observations, not a guarantee of model availability.',
    check: 'Check status / Refresh usage', refreshing: 'Checking…', cooldown: 'Wait a minute between read-only checks',
    checkAccount: 'Refresh this account', block_session: 'Limit: Session', 'block_30 days': 'Limit: 30 days', block_weekly: 'Limit: Weekly', block_both: 'Limit: Session + Weekly', block_unknown: 'Limit: scope unknown', recovery: 'Predicted recovery', recoveryUnknown: 'Recovery time unknown',
    account: 'Account / status', session: 'Session', weekly: 'Weekly', observation: 'Last observation',
    details: 'Details', closeDetails: 'Hide details', noObservation: 'No observation', historicalShort: 'hist.',
    bankedResets: 'Resets', usableResets: 'now', bankedResetsHelp: 'Vendor-reported banked and applicable reset counts at the last observation. ? means unknown; 0 usable does not mean the banked reset is lost. No reason for eligibility is inferred, and no reset is applied here.',
    localAlias: 'Local alias', saveAlias: 'Save alias', clearAlias: 'Clear alias',
    aliasHelp: 'Only on this device. Leave empty to restore the original label.',
    aliasSaved: 'Alias saved locally', aliasCleared: 'Original label restored',
    aliasError: 'Could not save the alias locally. The saved label has not changed.',
    aliasUnavailable: 'A stable account identity is unavailable; a local alias cannot be saved.',
    remainingMode: 'Remaining %', usedMode: 'Used %', displayMode: 'Quota display mode',
    resetPending: 'Reset elapsed · awaiting check', resetIn: 'Reset in', minutesAgo: 'min ago', hoursAgo: 'h ago', daysAgo: 'd ago', justNow: 'just now',
    short_available: 'Available', short_limit_reached: 'Limit reached', short_revoked: 'Sign in again',
    short_expired: 'Expired / expiring token', short_missing: 'Missing token', short_auth_required: 'Authentication failed',
    short_forbidden: 'Access denied', short_rate_limited: 'API rate-limited', short_unknown: 'Unknown',
    short_pending: 'Awaiting check', short_stale: 'Stale', freshness_unknown: 'Unknown freshness', quota_unknown: 'Unknown',
    automatic: 'Automatic observations', helpHeading: 'Help · read-only', providersHeading: 'Providers and order',
    providersHelp: 'Choose which providers to fetch and show. Saved provider choices and ordering are preserved.',
    providerScope: 'Provider scope', allProviders: 'All providers', codexOnly: 'Codex only',
    viewModeHelp: 'Codex only fetches and shows Codex even if previously disabled. Manual clocks are hidden, not deleted. Switch to All providers to edit and restore your saved provider choices and clocks. Saved locally per connection and profile.',
    viewModeError: 'Could not save the provider scope',
    resetProviders: 'Reset providers', moveUp: 'Move up', moveDown: 'Move down',
    emptyProviders: 'All providers are off. Enable a provider in Providers and order.',
    emptyUsage: 'No observations yet. Check provider settings and sign-in, then refresh.',
    manualHeading: 'Manual clocks', addClock: 'Add clock', close: 'Close',
    name: 'Name', planName: 'Plan name', reset: 'Reset', dashboardUrl: 'Dashboard URL (optional)', custom: 'Custom',
    cancel: 'Cancel', save: 'Save', open: 'Open', edit: 'Edit', remove: 'Remove', unavailable: 'Unavailable',
    used: 'used', left: 'left', manualNote: 'Typed by you. Update when the vendor page changes.', resetNow: 'Reset now', resets: 'Resets',
    gateway: 'Gateway', gateway_open: 'connected', gateway_idle: 'idle', gateway_closed: 'disconnected', gateway_connecting: 'connecting', gateway_reconnecting: 'reconnecting'
  },
  pl: {
    authLabel: 'Logowanie', quotaLabel: 'Limity', short_verified: 'Zalogowane',
    verified: 'Dane logowania zaakceptowano podczas ostatniego udanego odczytu z API zużycia; nie jest to gwarancja aktualnego logowania.',
    authHelp: 'Ostatnie uwierzytelnienie w API zużycia lub lokalna kontrola danych logowania, nie test generowania ani gwarancja aktualnego logowania. Wygaśnięcie tokenu dostępu nie dowodzi nieważności uprawnienia do odświeżania.',
    fresh: 'Aktualny odczyt', historical: 'Historyczny', short_fresh: 'Aktualne', short_historical: 'Historyczne',
    freshnessHelp: 'Aktualność odczytu limitów jest niezależna od logowania. Historyczne lub nieznane limity nie oznaczają bieżącej dostępności. Aktualny odczyt ma do 6 minut i żaden główny reset nie minął; pamięć podręczna nie odnawia czasu odczytu.',
    sortAccounts: 'Sortowanie kont', sort_default: 'Kolejność źródłowa', sort_session: 'Pozostało w sesji', sort_weekly: 'Pozostało w tygodniu', sort_reset: 'Najbliższy reset', sort_state: 'Stan',
    ascending: 'Rosnąco', descending: 'Malejąco', sortError: 'Nie zapisano sortowania',
    sortHelp: 'Tylko lokalnie. Sortowanie według pozostałego % także w trybie Zużyto. Przy sortowaniu limitów/resetów wartości historyczne i nieznane zawsze na końcu. Reset: przyszłe daty głównych okien Sesja/Tydzień z aktualnych odczytów. Stan rosnąco: dostępne, limit osiągnięty, oczekuje, nieaktualne, historyczne, nieznane; malejąco odwraca tę kolejność. Remisy zachowują kolejność źródła; kolejność źródłowa zachowuje kolejność dostawców. Zapis osobno dla połączenia i profilu.',
    available: 'Dostępne — potwierdzone przez API zużycia', limit_reached: 'Osiągnięto limit zużycia',
    revoked: 'Zaloguj się ponownie — nieważne zapisane uprawnienie', expired: 'Token wygasł / zaraz wygaśnie — bez sprawdzenia',
    missing: 'Brak tokenu dostępu — bez sprawdzenia', auth_required: 'Błąd uwierzytelnienia — odnowienie może pomóc',
    forbidden: 'Odmowa dostępu — przyczyna niepotwierdzona', rate_limited: 'API zużycia ograniczyło zapytania',
    unknown: 'Nieznany / sprawdzenie nieudane', pending: 'Czas resetu minął — oczekiwanie na sprawdzenie', stale: 'Nieaktualny odczyt — oczekiwanie na sprawdzenie',
    observed: 'Ostatni odczyt od dostawcy', never: 'Brak udanego odczytu od dostawcy', cached: 'Z pamięci podręcznej',
    inspected: 'Sprawdzono lokalne dane logowania', attempted: 'Ostatnia próba odczytu', grants: 'Wpisy danych logowania',
    guidance: 'Tylko odczyt: bez odnawiania tokenów i bez testów generowania. Nieważne uprawnienia: zaloguj właściwe konto ponownie w sekcji Konta Hermes. Wygaśnięcie tokenu dostępu nie dowodzi nieważności tokenu odświeżania. Nie ma tu wyboru aktywnego konta.',
    heading: 'Stan kont', windows: 'Okna limitów', history: 'Historyczny odczyt limitu',
    count: 'kont', help: 'Oddzielna kopia lokalna. Stan i limity to odczyty, nie gwarancja dostępności modelu.',
    check: 'Sprawdź stan / Odśwież zużycie', refreshing: 'Sprawdzanie…', cooldown: 'Odczekaj minutę między sprawdzeniami tylko do odczytu',
    checkAccount: 'Odśwież to konto', block_session: 'Limit: Sesja', 'block_30 days': 'Limit: 30 dni', block_weekly: 'Limit: Tydzień', block_both: 'Limit: Sesja + Tydzień', block_unknown: 'Limit: nieznany zakres', recovery: 'Przewidywany powrót', recoveryUnknown: 'Czas powrotu nieznany',
    account: 'Konto / stan', session: 'Sesja', weekly: 'Tydzień', observation: 'Dostępność / odczyt',
    details: 'Szczegóły', closeDetails: 'Ukryj szczegóły', noObservation: 'Brak odczytu', historicalShort: 'hist.',
    bankedResets: 'W zapasie', usableResets: 'do użycia', bankedResetsHelp: 'Liczby resetów w zapasie i możliwych do użycia, zgłoszone przez dostawcę podczas ostatniego odczytu. ? oznacza brak danych; 0 do użycia nie oznacza utraty resetu. Nie ustalamy przyczyny dostępności i nie wykorzystujemy resetów.',
    localAlias: 'Alias lokalny', saveAlias: 'Zapisz alias', clearAlias: 'Usuń alias',
    aliasHelp: 'Tylko na tym urządzeniu. Puste pole przywraca oryginalną etykietę.',
    aliasSaved: 'Alias zapisany lokalnie', aliasCleared: 'Przywrócono oryginalną etykietę',
    aliasError: 'Nie udało się zapisać aliasu lokalnie. Zapisana etykieta nie zmieniła się.',
    aliasUnavailable: 'Brak stabilnej tożsamości konta; nie można zapisać lokalnego aliasu.',
    remainingMode: 'Pozostało %', usedMode: 'Zużyto %', displayMode: 'Sposób wyświetlania limitu',
    resetPending: 'Reset minął · do sprawdzenia', resetIn: 'Reset za', minutesAgo: 'min temu', hoursAgo: 'godz. temu', daysAgo: 'dni temu', justNow: 'przed chwilą',
    short_available: 'Dostępne', short_limit_reached: 'Limit osiągnięty', short_revoked: 'Zaloguj się ponownie',
    short_expired: 'Token wygasł / wygasa', short_missing: 'Brak tokenu', short_auth_required: 'Błąd logowania',
    short_forbidden: 'Odmowa dostępu', short_rate_limited: 'Limit zapytań API', short_unknown: 'Nieznany',
    short_pending: 'Do sprawdzenia', short_stale: 'Nieaktualne', freshness_unknown: 'Nieznana aktualność', quota_unknown: 'Nieznane',
    automatic: 'Odczyty automatyczne', helpHeading: 'Pomoc · tylko odczyt', providersHeading: 'Dostawcy i kolejność',
    providersHelp: 'Wybierz dostawców, których dane mają być pobierane i wyświetlane. Zapisany wybór i kolejność zostają zachowane.',
    providerScope: 'Zakres dostawców', allProviders: 'Wszyscy dostawcy', codexOnly: 'Tylko Codex',
    viewModeHelp: 'Tylko Codex pobiera i pokazuje Codex, także gdy był wyłączony. Zegary ręczne są ukryte, nie usunięte. Wszyscy dostawcy przywraca zapisany wybór dostawców i zegary oraz umożliwia ich edycję. Zapis lokalny osobno dla połączenia i profilu.',
    viewModeError: 'Nie zapisano zakresu dostawców',
    resetProviders: 'Przywróć dostawców', moveUp: 'Przesuń w górę', moveDown: 'Przesuń w dół',
    emptyProviders: 'Wszyscy dostawcy są wyłączeni. Włącz dostawcę w sekcji Dostawcy i kolejność.',
    emptyUsage: 'Brak odczytów. Sprawdź dostawców i logowanie, następnie odśwież.',
    manualHeading: 'Zegary ręczne', addClock: 'Dodaj zegar', close: 'Zamknij',
    name: 'Nazwa', planName: 'Nazwa planu', reset: 'Reset', dashboardUrl: 'Adres panelu (opcjonalny)', custom: 'Własny',
    cancel: 'Anuluj', save: 'Zapisz', open: 'Otwórz', edit: 'Edytuj', remove: 'Usuń', unavailable: 'Niedostępne',
    used: 'zużyto', left: 'pozostało', manualNote: 'Wpisane ręcznie. Zaktualizuj, gdy zmieni się strona dostawcy.', resetNow: 'Reset teraz', resets: 'Reset',
    gateway: 'Brama', gateway_open: 'połączona', gateway_idle: 'bezczynna', gateway_closed: 'rozłączona', gateway_connecting: 'łączenie', gateway_reconnecting: 'ponowne łączenie'
  }
}

function localText(language = 'pl') {
  return key => LOCAL_TEXT[language]?.[key] || LOCAL_TEXT.pl[key] || key
}

function useLocalText() {
  // Polish copy is local to this plugin; Hermes locale is never changed.
  return localText()
}

function authStatusTitle(auth, t) {
  return `${t('authHelp')} · ${t(auth)}`
}

function quotaStatusLabel(availability, t, blockScope) {
  return availability === 'limit_reached' && blockScope ? t(`block_${blockScope}`)
    : availability === 'unknown' ? `${t('quotaLabel')}: ${t('quota_unknown')}` : t(`short_${availability}`)
}

function recoveryLabel(status, nowMs, t) {
  if (!status.blockScope) return ''
  const label = status.recoveryAt ? `${t('recovery')}: ${new Date(status.recoveryAt).toLocaleString()}` : t('recoveryUnknown')
  return `${label}${status.historical ? ` · ${t('historicalShort')}` : ''}`
}

function quotaWindowLabel(label, t) {
  return /^(Session|Weekly)$/i.test(label) ? t(String(label).toLowerCase() === 'session' ? 'session' : 'weekly') : label
}

function freshnessLabel(freshness, t) {
  return t(freshness === 'unknown' ? 'freshness_unknown' : `short_${freshness}`)
}


function cardsFromAccountSnapshots(snapshots) {
  const cards = []
  for (const snap of snapshots || []) {
    const accountLabel = snapshotAccountLabel(snap)
    const provider = providerTitle(snap.provider, snap.plan)
    const group = accountLabel ? familyTitle(snap.provider) : provider
    const accountTag = snapshotAccountKey(snap) ? `:${snapshotAccountKey(snap)}` : ''
    const extra = (snap.details || []).join(' · ')
    const windows = snap.windows || []
    const failed = Boolean(snap.error)
    const accountMeta = { snapshot: snap, accountKey: `${providerKey(snap.provider)}:${snapshotAccountKey(snap) || 'unknown'}`,
      observedAt: observedMillis(snap.fetched_at), cached: !!snap.cache_hit }
    if (failed) {
      // probe.py found a login but the fetch failed. Show why instead of
      // silently dropping the vendor from the page.
      cards.push({
        id: `account:${snap.provider}${accountTag}:error`,
        ...accountMeta,
        source: 'live',
        provider,
        group,
        account: accountLabel,
        label: accountLabel || provider,
        remaining: null,
        used: null,
        resetAt: null,
        resetText: '',
        detail: extra || `Could not fetch usage: ${String(snap.error)}`,
        error: true
      })
      continue
    }
    windows.forEach((window, index) => {
      cards.push({
        id: `account:${snap.provider}${accountTag}:${index}:${window.label}`,
        ...accountMeta,
        source: 'live',
        provider,
        group,
        account: index === 0 ? accountLabel : '',
        label: window.label,
        remaining: clampPercent(window.remaining_percent) ?? remainingFromUsed(window.used_percent),
        used: clampPercent(window.used_percent),
        resetAt: window.reset_at || null,
        resetText: '',
        detail: [window.detail, index === windows.length - 1 ? extra : ''].filter(Boolean).join(' · ')
      })
    })
    if (!windows.length && (extra || snap.account_status)) {
      cards.push({
        id: `account:${snap.provider}${accountTag}:note`,
        ...accountMeta,
        source: 'live',
        provider,
        group,
        account: accountLabel,
        label: accountLabel || provider,
        remaining: null,
        used: null,
        resetAt: null,
        resetText: '',
        detail: extra
      })
    }
  }
  return cards
}

function readSessionId() {
  const focused = host.state.focusedSessionId
  const active = host.state.activeSessionId
  return (focused && focused.get && focused.get()) || (active && active.get && active.get()) || ''
}

function hermesHomeFromConfig(payload) {
  const sections = (payload && payload.sections) || []
  for (const section of sections) {
    for (const row of section.rows || []) {
      if (row && row[0] === 'Config File' && row[1]) {
        return String(row[1]).replace(/[\\/]+config\.ya?ml$/i, '')
      }
    }
  }
  return ''
}

function hermesHomeCandidates(fromConfig) {
  const out = []
  const push = value => {
    const text = String(value || '').trim()
    if (text && !out.includes(text)) out.push(text)
    // Profiles share the base home's plugin install and Python runtime.
    const base = text.replace(/[\\/]profiles[\\/][^\\/]+[\\/]*$/i, '')
    if (base && base !== text && !out.includes(base)) out.push(base)
  }
  push(fromConfig)
  // config.show belongs to the selected gateway. Renderer environment paths
  // can belong to another machine and must not become backend candidates.
  return out
}

// Only these exact interpreter tokens intentionally expand on the backend.
const SHELL_RUNTIME_PYTHONS = new Set(['$HERMES_PYTHON', '%HERMES_PYTHON%'])

function shellSafe(value) {
  // No portable escaping exists inside double quotes across sh and cmd.exe.
  return !/["$`%!\r\n\0]/.test(String(value))
}

function quoteShell(value) {
  const text = String(value)
  if (!shellSafe(text) && !SHELL_RUNTIME_PYTHONS.has(text)) {
    throw new Error('Niebezpieczna ścieżka probe.py: znaki rozwijane przez powłokę są niedozwolone.')
  }
  return `"${text}"`
}

function probePythonCandidates(home) {
  const root = String(home || '').replace(/[\\/]+$/, '')
  const posix = [`${root}/hermes-agent/.venv/bin/python`, `${root}/hermes-agent/venv/bin/python`]
  const win = [
    `${root}/hermes-agent/.venv/Scripts/python.exe`,
    `${root}/hermes-agent/venv/Scripts/python.exe`
  ]
  const isWin = /^[A-Za-z]:[\\/]/.test(root) || root.includes('\\')
  const venv = isWin ? [...win, ...posix] : [...posix, ...win]
  // Hermes' own interpreter when the install says where it is. Nix and other
  // packaged installs keep no venv under the Hermes home; Hermes exports
  // HERMES_PYTHON instead. Expand it on the backend using its shell syntax.
  const runtime = [isWin ? '%HERMES_PYTHON%' : '$HERMES_PYTHON']
  // Bare interpreters last. On Mac and Windows these are usually a system
  // Python without httpx, which would "succeed" with an import error card.
  const generic = ['python3', 'python']
  const out = []
  for (const item of [...runtime, ...venv, ...generic]) {
    if (item && !out.includes(item)) out.push(item)
  }
  return out
}

// Python itself reports a missing script this way. Anything else that
// looks like "not found" means the interpreter path is wrong.
function probeFailureKind(result) {
  const err = result && result.stderr ? String(result.stderr) : ''
  if (/can't open file|No such file or directory: '.*probe\.py'/i.test(err)) return 'no-probe'
  if (
    result &&
    (result.code === 126 ||
      result.code === 127 ||
      result.code === 9009 ||
      /is not recognized|not found|No such file or directory|cannot find the path|Permission denied/i.test(err))
  ) {
    return 'no-python'
  }
  return 'failed'
}

// probe.py always exits 0 with a JSON list. When the interpreter lacks httpx
// that list includes a note card saying so. Treat it as "wrong Python" and keep
// looking rather than accepting it as the result.
function probeMissingDeps(parsed) {
  if (!Array.isArray(parsed)) return ''
  for (const snap of parsed) {
    if (!snap || String(snap.provider || '').toLowerCase() !== 'resetwatch') continue
    const note = (snap.details || []).find(line => /cannot import httpx/i.test(String(line)))
    if (note) return String(note)
  }
  return ''
}

function pickProbeFailure(failures) {
  const list = (failures || []).filter(item => item && item.message)
  if (!list.length) return ''
  // A real probe error (traceback, bad JSON) beats path guessing noise.
  const real = [...list].reverse().find(item => item.kind === 'failed')
  if (real) return real.message
  const kinds = new Set(list.map(item => item.kind))
  if (kinds.has('no-deps')) {
    return 'Found Python without httpx on this Gateway. Could not use the gateway runtime, backend HERMES_PYTHON/VIRTUAL_ENV, or home/PATH interpreters.'
  }
  if (kinds.has('no-probe') && !kinds.has('no-python')) {
    return 'probe.py not found in the standalone or combined-package installation on this Gateway'
  }
  if (kinds.has('no-python') && !kinds.has('no-probe')) {
    return 'No working Python found on this Gateway to start probe.py (checked backend HERMES_PYTHON and home/PATH interpreters)'
  }
  return list[list.length - 1].message
}

async function profileRequester(connectionId, profile, sessionId) {
  if (connectionId === null) throw new Error('Could not find the owner of the focused session')
  // The canonical owner requires a local session for shell.exec. Capture the
  // fetch's runtime id, not changing UI focus, for every pinned probe page.
  const shellRefusal = error => {
    const message = String(error && error.message || error || '')
    if (!/invalid[ _.-]*param(?:eter)?s|extra[_ -]forbidden|extra inputs are not permitted|(?:unexpected|extra)\s+(?:input|field|parameter)s?|permission.denied|forbidden|not.authorized/i.test(message)) return error
    const detail = !sessionId && /invalid[ _.-]*param(?:eter)?s|session_id/i.test(message)
      ? 'Otwórz lokalną rozmowę i odśwież dane — ten backend wymaga aktywnej sesji.'
      : 'Backend odrzucił parametry lub uprawnienia odczytu. Ponawianie z innym Pythonem nie pomoże.'
    return Object.assign(new Error(`Odmowa shell.exec: ${detail}`), { shellRefused: true })
  }
  let shellUsesSession = !!sessionId
  const invoke = async (send, method, params) => {
    if (method !== 'shell.exec') return send(method, params)
    try {
      return await send(method, shellUsesSession ? { ...params, session_id: sessionId } : params)
    } catch (error) {
      // Retry only a schema rejection: the command was not executed. Never
      // retry command failures, timeouts or auth errors (could duplicate work).
      const message = String(error && error.message || error || '')
      if (shellUsesSession && /\bsession_id\b/i.test(message) && /extra inputs are not permitted|extra[_ -]forbidden|(?:unexpected|extra)\s+(?:input|field|parameter)s?/i.test(message) && !/timeout|timed out|permission.denied|not.authorized/i.test(message)) {
        shellUsesSession = false
        try { return await send(method, params) }
        catch (fallbackError) { throw shellRefusal(fallbackError) }
      }
      throw shellRefusal(error)
    }
  }
  const active = String(profile || '').trim()
  if (!active || !connectionId || typeof host.profileRoutes !== 'function' || typeof host.requestProfile !== 'function') {
    return { request: (method, params = {}) => invoke((name, args) => host.request(name, args), method, params), profile: active }
  }
  const routes = await host.profileRoutes()
  const sourceRoutes = routes.filter(item => item && item.connectionId === connectionId)
  const route = sourceRoutes.find(item => item.profile === active) || sourceRoutes.find(item => item.targetProfile === active)
  if (!route) throw new Error(`No Desktop route for ${active}`)
  return {
    request: (method, params = {}) => invoke((name, args) => host.requestProfile(route, name, args), method, params),
    profile: route.targetProfile || route.profile
  }
}

// shell.exec returns only the last 4000 characters of stdout. Each probe
// invocation requests at most eight snapshots and probe.py also caps bytes.
const PROBE_SLICE = 8

function probeBuildWarning(page) {
  if (page.local_build === LOCAL_BUILD) return null
  const backend = typeof page.local_build === 'string' ? page.local_build.slice(0, 80) : 'brak identyfikatora (starszy probe.py)'
  return `Niezgodne wersje Resetwatch Local: UI ${LOCAL_BUILD}, probe.py ${backend}. Zaktualizuj oba pliki i przeładuj plugin. Odczyty poniżej wymagają ostrożności.`
}

function pinnedPage(text, expectedToken) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('probe returned non-JSON')
  }
  // probe.py main() reports a crash as a bare card list, even when paging.
  if (Array.isArray(parsed)) {
    if (!expectedToken) return { snapshot_token: null, snapshots: parsed }
    const crash = parsed.find(snap => snap && snap.provider === 'resetwatch')
    throw new Error((crash && String((crash.details || [])[0] || '')) || 'probe returned invalid snapshot pin')
  }
  const token = parsed && parsed.snapshot_token
  if (!/^[a-f0-9]{32}$/.test(token) || (expectedToken && token !== expectedToken) || !Array.isArray(parsed.snapshots)) {
    throw new Error('probe returned invalid snapshot pin')
  }
  return parsed
}

async function probeNextSlice(request, python, probe, flags, token, offset) {
  const result = await request('shell.exec', {
    command: `${quoteShell(python)} ${quoteShell(probe)}${flags.replace(' --fresh', '')} --snapshot-token=${token} --slice=${offset}:${PROBE_SLICE}`
  })
  if (!result || result.code) {
    throw new Error((result && String(result.stderr || '').trim()) || (result ? `probe exit ${result.code}` : 'probe returned nothing'))
  }
  const text = String(result.stdout || '').trim()
  return pinnedPage(text, token).snapshots
}

async function probeStockAccountUsage(request, opts) {
  try {
    const shown = await request('config.show', {})
    const found = hermesHomeCandidates(hermesHomeFromConfig(shown))
    if (!found.length) return { snapshots: null, error: 'Could not find Hermes home for probe.py' }
    const homes = found.filter(shellSafe)
    if (!homes.length) return { snapshots: null, error: 'Niebezpieczna ścieżka probe.py: znaki rozwijane przez powłokę są niedozwolone.' }
    const profileArg = String((opts && opts.profile) || '').trim()
    if (opts && opts.accountKey && !/^[a-f0-9]{20}$/.test(opts.accountKey)) return { snapshots: null, error: 'Invalid opaque account key' }
    if (profileArg && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profileArg)) {
      return { snapshots: null, error: 'Invalid Hermes profile name' }
    }
    const disabled = normalizeProviderPreferences({ disabled: opts && opts.disabled }).disabled
    const flags = [
      opts && opts.accountKey ? `--account-key=${opts.accountKey}` : '',
      '--gateway-runtime',
      disabled.length ? `--disabled-providers=${disabled.join(',')}` : '',
      profileArg ? `--profile ${quoteShell(profileArg)}` : '',
      opts && opts.cliOnly ? '--cli-only' : '',
      opts && opts.fresh ? '--fresh' : ''
    ]
      .filter(Boolean)
      .map(flag => ` ${flag}`)
      .join('')
    const failures = []
    // Never fall back to the original package: that would silently lose status safety.
    const probePaths = ['desktop-plugins/resetwatch-local/probe.py']
    // Each attempt spawns a process, so prune as we learn: an interpreter
    // that does not exist is skipped for every folder, and a folder Python
    // could not open is skipped for every interpreter.
    const deadPythons = new Set()
    const deadProbes = new Set()
    const pythons = [...new Set(homes.flatMap(probePythonCandidates).filter(item => item !== 'python3' && item !== 'python')),
      'python3', 'python']
    for (const home of homes) {
      for (const python of pythons) {
        if (deadPythons.has(python)) continue
        for (const relativePath of probePaths) {
          const probe = `${home}/${relativePath}`
          if (deadProbes.has(probe)) continue
          try {
            const result = await request('shell.exec', {
              command: `${quoteShell(python)} ${quoteShell(probe)}${flags} --pin-snapshot --slice=0:${PROBE_SLICE}`
            })
            if (!result || result.code) {
              const err = result && result.stderr ? String(result.stderr).trim() : ''
              const kind = probeFailureKind(result)
              failures.push({
                kind,
                message: err || (result ? `probe exit ${result.code}` : 'probe returned nothing')
              })
              if (kind === 'no-python') {
                deadPythons.add(python)
                break
              }
              if (kind === 'no-probe') deadProbes.add(probe)
              continue
            }
            const text = String(result.stdout || '').trim()
            const first = pinnedPage(text)
            const missingDeps = probeMissingDeps(first.snapshots)
            if (missingDeps) {
              // Wrong interpreter for every home, not just this one.
              failures.push({ kind: 'no-deps', message: missingDeps })
              deadPythons.add(python)
              break
            }
            if (!first.snapshot_token) return { snapshots: first.snapshots, error: probeBuildWarning(first) }
            try {
              const all = [...first.snapshots]
              let offset = all.length
              // A short page can mean byte-budget exhaustion, not end of list.
              for (let page = 0; offset && page < 256; page++) {
                const next = await probeNextSlice(request, python, probe, flags, first.snapshot_token, offset)
                if (!next.length) break
                all.push(...next)
                offset += next.length
                if (page === 255) throw new Error('probe returned too many pages')
              }
              return { snapshots: all, error: probeBuildWarning(first) }
            } catch (error) {
              // A valid first page owns this invocation. Never restart with
              // another interpreter or a newer cache after a pin fails.
              return { snapshots: null, error: errorMessage(error, 'probe snapshot failed') }
            }
          } catch (error) {
            if (error && error.shellRefused) return { snapshots: null, error: error.message }
            failures.push({ kind: 'failed', message: errorMessage(error, 'probe failed') })
          }
        }
      }
    }
    return {
      snapshots: null,
      error: pickProbeFailure(failures) || 'Could not run probe.py (no working Hermes Python)'
    }
  } catch (error) {
    return { snapshots: null, error: errorMessage(error, 'Could not run probe.py') }
  }
}

function go(route) {
  if (typeof host.navigate === 'function') host.navigate(route)
}

async function fetchLiveCards(sessionId, opts, connectionId, profile) {
  const cards = []
  const errors = []
  const sid = sessionId || readSessionId()
  const fresh = !!(opts && opts.fresh)
  const disabled = normalizeProviderPreferences({ disabled: opts && opts.disabled }).disabled
  if (opts && opts.accountKey) {
    const match = /^openai-codex:([a-f0-9]{20})$/.exec(opts.accountKey)
    if (!match) return { cards: [], errors: ['Invalid opaque account target'] }
    const target = await profileRequester(connectionId, profile, sid)
    const result = await probeStockAccountUsage(target.request, { fresh: true, accountKey: match[1], profile: target.profile, disabled })
    return { cards: cardsFromAccountSnapshots(result.snapshots || []), errors: result.error ? [result.error] : [] }
  }
  const nousEnabled = !disabled.includes('nous')
  if (disabled.length === LIVE_PROVIDERS.length) {
    return { cards: [], errors: [], hadSession: Boolean(sid), haveAccountRpc: false }
  }
  const haveAccountRpc = false
  const target = await profileRequester(connectionId, profile, sid)
  const request = target.request

  // account.usage and /usage may resolve/refresh OAuth. Only the copied read-only
  // probe owns account quota; existing Nous state RPCs retain their normal role.
  const [barsResult] = await Promise.allSettled([
    nousEnabled ? request('usage.bars', {}) : Promise.resolve(null)
  ])

  let barsError = ''
  if (barsResult.status === 'fulfilled') {
    cards.push(...cardsFromUsageBars(barsResult.value))
  } else {
    const error = barsResult.reason
    barsError = error && error.message ? error.message : 'Could not read Nous usage'
  }

  if (nousEnabled && !cards.length) {
    try {
      const sub = await request('subscription.state', {})
      if (sub && sub.usage) cards.push(...cardsFromUsageBars(sub.usage))
    } catch (error) {
      errors.push(error && error.message ? error.message : 'Could not read subscription state')
    }
  }
  // Only report the usage.bars failure if the fallback did not fill the Nous cards.
  if (barsError && !cards.some(card => String(card.id).startsWith('nous:'))) {
    errors.push(barsError)
  }

  const probeResult = disabled.filter(key => key !== 'nous').length === LIVE_PROVIDERS.length - 1
    ? { snapshots: [], error: null }
    : await probeStockAccountUsage(request, { cliOnly: haveAccountRpc, fresh, profile: target.profile, disabled })
  const probed = probeResult && probeResult.snapshots
  if (probeResult && probeResult.error && !(probed && probed.length)) {
    errors.push(probeResult.error)
  }
  if (probed && probed.length) cards.push(...cardsFromAccountSnapshots(probed))

  const seen = new Set()
  const unique = []
  for (const card of cards) {
    if (seen.has(card.id)) continue
    seen.add(card.id)
    unique.push(card)
  }
  return { cards: arrangeProviderCards(unique, { disabled }), errors, hadSession: Boolean(sid), haveAccountRpc }
}

function SmallButton({ onClick, children, active, title, disabled }) {
  return jsx('button', {
    type: 'button',
    title,
    disabled: !!disabled,
    onClick,
    style: {
      fontSize: '0.8125rem',
      padding: '2px 8px',
      border: `1px solid ${active ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}`,
      borderRadius: 4,
      color: active ? text.primary : text.secondary,
      background: active ? 'var(--ui-control-active-background)' : 'transparent',
      opacity: disabled ? 0.5 : 1,
      cursor: disabled ? 'default' : 'pointer'
    },
    children
  })
}

function Field({ label, children }) {
  return jsxs('label', {
    style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 },
    children: [
      jsx('span', { style: { fontSize: '0.6875rem', color: text.tertiary }, children: label }),
      children
    ]
  })
}

function NativeInput({ value, onChange, type, placeholder, style }) {
  return jsx('input', {
    type: type || 'text',
    value: value || '',
    placeholder,
    onChange: event => onChange(event.target.value),
    style: {
      height: 28,
      padding: '0 8px',
      borderRadius: 6,
      border: '1px solid var(--ui-stroke-secondary)',
      background: 'transparent',
      color: text.primary,
      fontSize: '0.8125rem',
      outline: 'none',
      ...style
    }
  })
}

function UsageBar({ remaining, percent, label }) {
  const tone = toneForRemaining(remaining)
  const fill = tone === 'bad' ? text.red : tone === 'warn' ? text.yellow : 'var(--ui-text-primary)'
  return jsx('div', {
    role: 'meter',
    'aria-label': label,
    'aria-valuemin': 0,
    'aria-valuemax': 100,
    'aria-valuenow': percent,
    style: {
      width: '100%',
      minWidth: 92,
      height: 6,
      borderRadius: 99,
      background: 'var(--ui-stroke-secondary)',
      overflow: 'hidden',
      flexShrink: 0
    },
    children: jsx('div', {
      style: {
        width: `${percent}%`,
        height: '100%',
        borderRadius: 99,
        background: fill
      }
    })
  })
}

function displayDetail(card) {
  const detail = String((card && card.detail) || '').trim()
  if (!detail) return ''
  // The meter and percentage already show the same unitless fraction.
  if (card.remaining !== null && card.remaining !== undefined) {
    if (/^[\d,]+\s+of\s+[\d,]+\s+left$/i.test(detail)) return ''
  }
  return detail
}

function renderDetailText(detail) {
  const value = String(detail || '')
  const marker = 'Peak pricing now'
  const index = value.indexOf(marker)
  if (index < 0) return value
  return jsxs(Fragment, {
    children: [
      value.slice(0, index),
      jsx('span', { style: { fontWeight: 700 }, children: marker }),
      value.slice(index + marker.length)
    ]
  })
}

function LimitCard({ card, nowMs, actions }) {
  const t = useLocalText()
  const status = card.snapshot ? deriveAccountStatus(card.snapshot, nowMs) : null
  const historical = status && !['available', 'limit_reached'].includes(status.state)
  const displayMode = useValue($displayMode)
  const remaining = quotaPercent(card, 'remaining')
  const percent = quotaPercent(card, displayMode)
  const tone = toneForRemaining(remaining)
  const reset = formatReset(card.resetAt, card.resetText, nowMs)
  const percentLabel = `${percent}% ${t(displayMode === 'used' ? 'used' : 'left')}`
  const detail = displayDetail(card)
  return jsxs('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      padding: '12px 14px',
      borderRadius: 10,
      border: '1px solid var(--ui-stroke-secondary)',
      background: 'var(--ui-bg-secondary, transparent)'
    },
    children: [
      jsxs('div', {
        style: { flex: 1, minWidth: 0 },
        children: [
          jsx('div', {
            style: { fontSize: '0.875rem', fontWeight: 600, color: text.primary },
            children: quotaWindowLabel(card.label, t)
          }),
          card.account
            ? jsx('div', {
                style: { fontSize: '0.75rem', color: text.tertiary, marginTop: 2 },
                children: card.account
              })
            : null,
          reset
            ? jsx('div', {
                style: { fontSize: '0.75rem', color: text.tertiary, marginTop: 2 },
                children: reset.startsWith('Resets') || reset.startsWith('Reset') ? reset : `${t('resets')} ${reset}`
              })
            : null,
          card.snapshot
            ? jsx('div', { style: { fontSize: '0.6875rem', color: text.tertiary, marginTop: 4 },
                children: [card.observedAt ? `${t('observed')}: ${new Date(card.observedAt).toLocaleString()}` : t('never'), card.cached ? t('cached') : '', historical ? t('history') : ''].filter(Boolean).join(' · ') })
            : null,
          detail
            ? jsx('div', {
                style: { fontSize: '0.75rem', color: text.tertiary, marginTop: 2 },
                children: renderDetailText(detail)
              })
            : null
        ]
      }),
      card.error
        ? jsx('div', {
            title: detail,
            style: { fontSize: '0.75rem', color: text.quaternary, flexShrink: 0 },
            children: t('unavailable')
          })
        : percent === null
          ? null
          : jsxs('div', {
              style: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
              children: [
                jsx(UsageBar, { remaining, percent, label: `${card.label}: ${percentLabel}` }),
                jsx('div', {
                  style: { fontSize: '0.8125rem', color: toneColor(tone), minWidth: 64, textAlign: 'right' },
                  children: percentLabel
                })
              ]
            }),
      actions || null
    ]
  })
}

function useSectionOpen(key) {
  const [open, setOpen] = useState(() => {
    const saved = stored(`sectionOpen:${key}`, null)
    return saved === null || saved === undefined ? true : !!saved
  })
  return [
    open,
    () => {
      const next = !open
      setOpen(next)
      remember(`sectionOpen:${key}`, next)
    }
  ]
}

function SectionHeader({ title, open, onToggle, extra }) {
  return jsxs('div', {
    style: { display: 'flex', alignItems: 'center', gap: 8 },
    children: [
      jsxs('button', {
        type: 'button',
        onClick: () => {
          tap()
          onToggle()
        },
        'aria-expanded': open,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flex: 1,
          minWidth: 0,
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: text.primary,
          cursor: 'pointer',
          textAlign: 'left'
        },
        children: [
          jsx('span', {
            style: { fontSize: '0.7rem', color: text.tertiary, width: 10 },
            children: open ? '▾' : '▸'
          }),
          jsx('h2', {
            style: { fontSize: '0.75rem', fontWeight: 600, color: text.primary, margin: 0 },
            children: title
          })
        ]
      }),
      extra || null
    ]
  })
}

function AccountStatusCard({ snap, nowMs }) {
  const t = useLocalText()
  const status = deriveAccountStatus(snap, nowMs)
  const { state, auth, freshness, availability, historical, tightest, blockScope } = status
  const observedAt = observedMillis(snap.fetched_at)
  const stamp = value => { const ms = observedMillis(value); return ms ? new Date(ms).toLocaleString() : '—' }
  return jsxs('div', {
    'data-account-status': state,
    style: { padding: '10px 14px', border: '1px solid var(--ui-stroke-secondary)', borderRadius: 10, fontSize: '0.75rem', display: 'flex', flexDirection: 'column', gap: 5 },
    children: [
      jsx('strong', { children: snapshotAccountLabel(snap) || familyTitle(snap.provider) }),
      jsx('span', { 'data-auth-health': auth, title: authStatusTitle(auth, t), style: { color: auth === 'revoked' ? text.red : text.secondary }, children: t(`short_${auth}`) }),
      jsx('span', { 'data-quota-availability': availability, title: t(availability), children: quotaStatusLabel(availability, t, blockScope) }),
      blockScope ? jsx('span', { children: `${availability !== 'limit_reached' ? `${t(`block_${blockScope}`)} · ` : ''}${recoveryLabel(status, nowMs, t)}` }) : null,
      tightest && !blockScope ? jsx('span', { children: `${quotaWindowLabel(tightest.label, t)}: ${clampPercent(tightest.used_percent)}% ${t('used')}${historical ? ` · ${t('history')}` : ''}${tightest.reset_at ? ` · ${formatReset(tightest.reset_at, '', nowMs)}` : ''}` }) : null,
      jsx('span', { style: { color: text.tertiary }, children: `${snap.source_host || ''} · ID ${snapshotAccountKey(snap).slice(0, 10)} · ${snap.plan || ''}` }),
      jsx('span', { 'data-quota-freshness': freshness, title: t('freshnessHelp'), children: `${observedAt ? `${t('observed')}: ${stamp(snap.fetched_at)}` : t('never')} · ${freshnessLabel(freshness, t)}${snap.cache_hit ? ` · ${t('cached')}` : ''}` }),
      snap.last_attempt_at ? jsx('span', { children: `${t('attempted')}: ${stamp(snap.last_attempt_at)}` }) : null,
      snap.inspected_at ? jsx('span', { children: `${t('inspected')}: ${stamp(snap.inspected_at)}` }) : null,
      jsx('span', { children: `${t('grants')}: ${snap.grant_count || 1} · ${Object.entries(snap.grant_states || {}).map(([key, count]) => `${key}: ${count}`).join(' · ')}` }),
      bankedResetCount(snap) > 0 ? jsx('span', { style: { color: text.tertiary }, children: `${resetBalanceLabel(snap, t, freshness !== 'fresh')} · ${t('bankedResetsHelp')}` }) : null,
      bankedResetCount(snap) > 0 ? jsx('div', { style: { whiteSpace: 'pre-line', fontSize: '13px' }, children: resetExpirySummary(snap, Date.now()).full }) : null,
      state !== 'available' && state !== 'limit_reached' ? jsx('span', { style: { color: text.tertiary }, children: t('guidance') }) : null
    ]
  })
}

const overviewCellStyle = { padding: '5px 8px', textAlign: 'left', verticalAlign: 'middle', borderBottom: '1px solid var(--ui-stroke-secondary)' }

function compactReset(resetAt, nowMs, t) {
  if (!resetAt) return '—'
  const delta = Date.parse(resetAt) - nowMs
  if (!Number.isFinite(delta)) return '—'
  if (delta <= 0) return t('resetPending')
  const minutes = Math.max(1, Math.ceil(delta / 60000))
  if (minutes < 60) return `${t('resetIn')} ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${t('resetIn')} ${hours} h ${minutes % 60} min`
  return `${t('resetIn')} ${Math.floor(hours / 24)} d ${hours % 24} h`
}

function compactObservation(value, nowMs, t) {
  const observed = observedMillis(value)
  if (!observed || observed > nowMs + 60000) return t('noObservation')
  const minutes = Math.max(0, Math.floor((nowMs - observed) / 60000))
  if (minutes < 1) return t('justNow')
  if (minutes < 60) return `${minutes} ${t('minutesAgo')}`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} ${t('hoursAgo')}`
  return `${Math.floor(minutes / 1440)} ${t('daysAgo')}`
}

function bankedResetCount(snap) {
  if (snap.rate_limit_reset_credits && typeof snap.rate_limit_reset_credits === 'object') {
    const count = snap.rate_limit_reset_credits.available_count
    return Number.isSafeInteger(count) && count >= 0 ? count : null
  }
  // probe.py emits this exact vendor-derived detail from available_count.
  // Missing/invalid metadata is unknown, not zero; do not infer from quotas.
  for (const detail of snap.details || []) {
    const match = String(detail).match(/^You have (\d+) resets? banked$/)
    if (!match) continue
    const count = Number(match[1])
    if (Number.isSafeInteger(count) && count >= 0) return count
  }
  return null
}

function resetExpirySummary(snap, nowMs) {
  const data = snap.banked_reset_details
  if (!data || data.status !== 'verified') return { short: 'Ważność: nieznana', full: 'Nie udało się pobrać dat ważności resetów.' }
  const credits = Array.isArray(data.credits) ? data.credits : []
  const dated = credits.filter(row => row.expires_at && Number.isFinite(Date.parse(row.expires_at)))
    .sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at))
  const observed = Number(data.observed_at) * 1000
  const stale = !Number.isFinite(observed) || nowMs - observed > POLL_MS + REFRESH_COOLDOWN_MS || dated.some(row => Date.parse(row.expires_at) <= nowMs)
  const stamp = stale ? ' · do sprawdzenia' : ''
  const format = value => new Date(value).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const full = credits.map((row, index) => `Reset ${index + 1}: ${row.expires_at ? format(row.expires_at) : 'brak podanej daty wygaśnięcia'}`).join('\n')
  const incomplete = credits.length !== bankedResetCount(snap) ? '\nLista szczegółów może być niepełna; licznik pochodzi z osobnego odczytu.' : ''
  return { short: dated.length ? `Wygasa: ${new Date(dated[0].expires_at).toLocaleDateString('pl-PL', {day:'2-digit',month:'2-digit'})}${stamp}` : `Ważność: brak dat${stamp}`,
    full: (full || 'Brak szczegółów resetów w odpowiedzi.') + incomplete + stamp }
}

function resetBalanceLabel(snap, t, historical) {
  const applicable = snap.rate_limit_reset_credits && snap.rate_limit_reset_credits.applicable_available_count
  const usable = Number.isSafeInteger(applicable) && applicable >= 0 ? applicable : '?'
  return `${t('bankedResets')}: ${bankedResetCount(snap)} · ${t('usableResets')}: ${usable}${historical ? ` · ${t('historicalShort')}` : ''}`
}

function OverviewQuota({ snap, label, state, freshness, nowMs }) {
  const t = useLocalText()
  const mode = useValue($displayMode)
  const window = (snap.windows || []).find(item => String(item.label).toLowerCase() === label.toLowerCase())
    || (label === 'Weekly' ? (snap.windows || []).find(item => item.label === '30 days') : null)
  const card = { remaining: window && window.remaining_percent, used: window && window.used_percent }
  const percent = quotaPercent(card, mode)
  const remaining = quotaPercent(card, 'remaining')
  const historical = !['available', 'limit_reached'].includes(state)
  const banked = label === 'Weekly' ? bankedResetCount(snap) : null
  return jsxs('td', { style: overviewCellStyle, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', lineHeight: '20px' }, children: [
      window && window.label === '30 days' ? jsx('span', { style: { fontSize: '13px', color: text.secondary }, children: '30 dni' }) : null,
      jsx('strong', { style: { minWidth: 40, flexShrink: 0, color: toneColor(toneForRemaining(remaining)) }, children: percent === null ? '—' : `${percent}%` }),
      percent === null ? null : jsx('span', { style: { display: 'inline-flex', flex: '1 1 0', minWidth: 92 }, children: jsx(UsageBar, { remaining, percent, label: `${t(label === 'Session' ? 'session' : 'weekly')}: ${percent}% ${t(mode === 'used' ? 'usedMode' : 'remainingMode')}` }) }),
      historical && percent !== null ? jsx('span', { title: t('history'), style: { fontSize: '13px', color: text.secondary }, children: t('historicalShort') }) : null
    ] }),
    jsxs('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 6px', color: text.secondary, fontSize: '13px', lineHeight: '18px' }, children: [
      window ? compactReset(window.reset_at, nowMs, t) : '—',
      banked > 0 ? jsx('span', { 'data-banked-resets': banked,
        title: `${t('bankedResetsHelp')} · ${t('observed')}: ${observedMillis(snap.fetched_at) ? new Date(observedMillis(snap.fetched_at)).toLocaleString() : t('never')}`,
        style: { maxWidth: '100%', boxSizing: 'border-box', border: '1px solid var(--ui-stroke-secondary)', borderRadius: 4, padding: '0 4px', fontSize: '13px' },
        children: resetBalanceLabel(snap, t, freshness !== 'fresh') }) : null,
      banked > 0 ? jsx('span', { 'data-reset-expiry': true, title: resetExpirySummary(snap, nowMs).full, style: { fontSize: '13px', color: text.secondary }, children: resetExpirySummary(snap, nowMs).short }) : null
    ] })
  ] })
}

function AccountAliasEditor({ accountKey, alias }) {
  const t = useLocalText()
  const [draft, setDraft] = useState(alias)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => { setDraft(alias); setMessage(''); setFailed(false) }, [accountKey, alias])
  const save = value => {
    const ok = saveAccountAlias(accountKey, value)
    setFailed(!ok)
    if (ok) setDraft(String(value || '').trim().slice(0, ALIAS_MAX_LENGTH))
    setMessage(ok ? String(value || '').trim() ? 'aliasSaved' : 'aliasCleared' : 'aliasError')
  }
  if (!accountKey) return jsx('span', { style: { color: text.tertiary, fontSize: '0.6875rem' }, children: t('aliasUnavailable') })
  return jsxs('form', {
    onSubmit: event => { event.preventDefault(); save(draft) },
    style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'end', gap: 6, flexWrap: 'wrap', maxWidth: 440 }, children: [
        jsx(Field, { label: t('localAlias'), children: jsx('input', {
          type: 'text', value: draft, maxLength: ALIAS_MAX_LENGTH,
          onChange: event => { setDraft(event.target.value); setMessage(''); setFailed(false) },
          style: { height: 28, minWidth: 140, width: '100%', boxSizing: 'border-box', padding: '0 8px', borderRadius: 6,
            border: '1px solid var(--ui-stroke-secondary)', background: 'transparent', color: text.primary, fontSize: '0.8125rem' }
        }) }),
        jsx('button', { type: 'submit', style: { fontSize: '0.6875rem', padding: '4px 8px', borderRadius: 4,
          border: '1px solid var(--ui-stroke-secondary)', background: 'transparent', color: text.secondary, cursor: 'pointer' }, children: t('saveAlias') }),
        jsx(SmallButton, { disabled: !alias && !draft, onClick: () => save(''), children: t('clearAlias') })
      ] }),
      jsx('span', { style: { color: text.tertiary, fontSize: '0.6875rem' }, children: t('aliasHelp') }),
      message ? jsx('span', { role: failed ? 'alert' : 'status', style: { color: failed ? text.red : text.tertiary, fontSize: '0.6875rem' }, children: t(message) }) : null
    ]
  })
}

// Assisted mode deliberately never starts auth through shell.exec or Providers.
// The official CLI owns OAuth, browser interaction and credential persistence.
function assistedCodexCommand({ profile, label = '', shell = 'sh' }) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profile || '') || !['sh', 'powershell'].includes(shell)) throw new Error('Nieustalony profil lub terminal.')
  const name = String(label).trim()
  if (name.length > ALIAS_MAX_LENGTH || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(String(label))) throw new Error('Nazwa zawiera niedozwolone znaki lub jest za długa.')
  // POSIX sh and PowerShell single quotes suppress substitutions. Not cmd.exe.
  const quote = value => shell === 'powershell' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`
  return `hermes --profile ${quote(profile)} auth add openai-codex --type oauth${name ? ` --label=${quote(name)}` : ''}`
}

function assistedCodexScopeMatches(connectionId, profile, sessionId) {
  const state = host.state
  if (connectionId === null || (state.focusedSessionId?.get() || '') !== (sessionId || '')) return false
  if (state.focusedSessionOwner) {
    const owner = state.focusedSessionOwner.get()
    return !!owner && owner.connectionId === connectionId && owner.profile === profile
  }
  const focused = state.focusedSessionProfile?.get()
  const active = state.profile?.get()
  return !(focused && focused !== active) && (state.connectionId?.get() || '') === connectionId && (focused || active) === profile
}

function AssistedCodexAdd({ connectionId, profile, sessionId, blocked, onRefresh }) {
  const [label, setLabel] = useState('')
  const [shell, setShell] = useState('sh')
  const [prepared, setPrepared] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const sequence = useRef(0)
  const lock = useRef(false)
  useEffect(() => () => { sequence.current++ }, [])
  const inScope = () => assistedCodexScopeMatches(connectionId, profile, sessionId)
  const clear = () => { sequence.current++; lock.current = false; setBusy(false); setPrepared(null); setMessage('') }
  let valid = false
  try { assistedCodexCommand({ profile, label, shell }); valid = connectionId !== null } catch { /* fail closed */ }
  const prepare = async event => {
    event.preventDefault()
    if (lock.current || blocked || !valid || !inScope()) return
    const ticket = ++sequence.current
    lock.current = true; setBusy(true); setPrepared(null); setMessage('')
    try {
      // Resolve mapped profile names through the existing supported route seam.
      // This only discovers routing; no config, shell or credential RPC is sent.
      const target = await profileRequester(connectionId, profile, sessionId)
      const command = assistedCodexCommand({ profile: target.profile, label, shell })
      if (ticket === sequence.current && inScope()) setPrepared({ command, profile: target.profile })
    } catch {
      if (ticket === sequence.current) setMessage('Nie można ustalić profilu. Niczego nie uruchomiono; sprawdź połączenie i profil.')
    } finally {
      if (ticket === sequence.current) { lock.current = false; setBusy(false) }
    }
  }
  const copy = async () => {
    if (lock.current || !prepared || blocked || !inScope()) return
    const ticket = ++sequence.current
    lock.current = true; setBusy(true)
    try {
      const ok = os && typeof os.writeClipboard === 'function' && await os.writeClipboard(prepared.command)
      if (ticket === sequence.current && inScope()) setMessage(ok ? 'Skopiowano polecenie. Nie uruchomiono logowania — wklej je do właściwego terminala.' : 'Schowek niedostępny. Zaznacz i skopiuj polecenie ręcznie.')
    } catch {
      if (ticket === sequence.current && inScope()) setMessage('Schowek niedostępny. Zaznacz i skopiuj polecenie ręcznie.')
    } finally {
      if (ticket === sequence.current) { lock.current = false; setBusy(false) }
    }
  }
  const refresh = async () => {
    if (lock.current || blocked || !inScope() || typeof onRefresh !== 'function') return
    const ticket = ++sequence.current
    lock.current = true; setBusy(true); setMessage('')
    try {
      await onRefresh()
      if (ticket === sequence.current && inScope()) setMessage('Zakończono odświeżenie listy. Nie potwierdza dodania konta — sprawdź wynik CLI i właściwy wiersz; dane mogą być z pamięci podręcznej.')
    } catch {
      if (ticket === sequence.current && inScope()) setMessage('Odświeżenie listy nie powiodło się. Nie oznacza to powodzenia ani niepowodzenia logowania; sprawdź wynik CLI.')
    } finally {
      if (ticket === sequence.current) { lock.current = false; setBusy(false) }
    }
  }
  return jsxs('details', { 'data-codex-add-assisted': true,
    onToggle: event => { if (!event.currentTarget.open) clear() },
    style: { border: '1px solid var(--ui-stroke-secondary)', borderRadius: 6, padding: '6px 10px', fontSize: '0.75rem', color: text.secondary }, children: [
      jsx('summary', { style: { cursor: 'pointer', color: text.primary }, children: 'Dodaj konto Codex' }),
      jsx('p', { children: 'Tryb wspomagany: Resetwatch nie uruchamia ani nie potwierdza logowania. Przygotuj polecenie, uruchom je samodzielnie w terminalu, a logowanie zatwierdź w przeglądarce otwartej przez Hermes CLI. Nie wklejaj tutaj tokenów ani kodów logowania.' }),
      jsx('p', { children: `Połączenie: ${connectionId || 'bieżące'} · profil w Desktop: ${profile || 'nieustalony'}. Użyj terminala na tym samym komputerze / gatewayu i tego samego HERMES_HOME co Hermes. Dla zdalnego gatewaya użyj jego terminala, nie lokalnego.` }),
      jsxs('form', { onSubmit: prepare, style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }, children: [
        jsx('input', { type: 'text', 'aria-label': 'Nazwa konta Codex (opcjonalna)', placeholder: 'Nazwa konta (opcjonalna)', value: label, maxLength: ALIAS_MAX_LENGTH,
          onChange: event => { clear(); setLabel(event.target.value) },
          style: { minWidth: 140, flex: '1 1 180px', color: text.primary, background: 'transparent', border: '1px solid var(--ui-stroke-secondary)', borderRadius: 4, padding: '4px 6px' } }),
        jsx('select', { 'aria-label': 'Terminal dla polecenia Codex', value: shell, style: nativeSelectStyle,
          onChange: event => { clear(); setShell(event.target.value) }, children: [
            jsx('option', { value: 'sh', style: nativeOptionStyle, children: 'POSIX sh / bash / zsh' }),
            jsx('option', { value: 'powershell', style: nativeOptionStyle, children: 'PowerShell (nie cmd.exe)' })
          ] }),
        jsx('button', { type: 'submit', disabled: busy || blocked || !valid, style: { color: text.primary, background: 'transparent', border: '1px solid var(--ui-stroke-secondary)', borderRadius: 4, padding: '4px 8px', cursor: 'pointer' }, children: 'Przygotuj polecenie' })
      ] }),
      jsx('p', { children: 'Nazwa trafia do oficjalnego --label; pusta oznacza automatyczną nazwę CLI. Lokalny alias nadal ustawisz w Szczegółach dokładnie wybranego konta. Resetwatch nie przypisuje aliasu automatycznie do nowego lub podobnie nazwanego wiersza.' }),
      prepared ? jsxs('div', { children: [
        jsx('p', { children: `Docelowy profil CLI: ${prepared.profile}. Polecenie dla ${shell === 'powershell' ? 'PowerShell' : 'POSIX sh / bash / zsh'}:` }),
        jsx('textarea', { 'aria-label': 'Polecenie logowania Codex', value: prepared.command, readOnly: true, rows: 3, spellCheck: false,
          style: { width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace', color: text.primary, background: 'transparent', border: '1px solid var(--ui-stroke-secondary)', borderRadius: 4, padding: 6 } }),
        jsx(SmallButton, { disabled: busy || blocked, onClick: copy, children: 'Kopiuj polecenie' })
      ] }) : null,
      jsx('p', { children: 'Wybierz inne konto OpenAI, jeśli chcesz osobny limit. Ponowne logowanie do tego samego konta nie dodaje limitu i może unieważnić starszy grant. Niczego nie usuwamy automatycznie. Hermes CLI może ponownie dopuścić wcześniej zablokowane źródła Codex; pierwszy wpis może ustawić aktywnego dostawcę, jeśli nie był wybrany.' }),
      jsx('p', { children: 'Przerwanie / timeout: Ctrl+C w terminalu lub poczekaj na wygaśnięcie oficjalnego logowania. Zamknięcie tej instrukcji nie zatrzymuje CLI. Po sukcesie CLI odśwież listę poniżej; nazwa nie dowodzi tożsamości konta. Jeśli Codex jest wyłączony w filtrach, włącz go samodzielnie, aby zobaczyć konto.' }),
      jsx(SmallButton, { disabled: busy || blocked || !valid, onClick: refresh, children: 'Odśwież listę po logowaniu' }),
      message ? jsx('p', { role: 'status', children: message }) : null
    ] })
}

async function prepareCredentialRemoval({ accountKey, connectionId, profile, sessionId }) {
  const match = /^openai-codex:([a-f0-9]{20})$/.exec(accountKey)
  if (!match || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profile || '') || connectionId === null) throw new Error('Nieustalony profil lub konto — usuwanie zablokowane.')
  const target = await profileRequester(connectionId, profile, sessionId)
  const shown = await target.request('config.show', {})
  const homes = hermesHomeCandidates(hermesHomeFromConfig(shown)).filter(shellSafe)
  const pythons = [...new Set(homes.flatMap(probePythonCandidates)), 'python3', 'python']
  for (const home of homes) for (const python of pythons) {
    const command = `${quoteShell(python)} ${quoteShell(`${home}/desktop-plugins/resetwatch-local/probe.py`)} --profile ${quoteShell(target.profile)}`
    let result
    try { result = await target.request('shell.exec', { command: `${command} --credential-plan=${match[1]}` }) }
    catch (error) { if (error && error.shellRefused) throw error; continue }
    if (!result || result.code) continue // Discovery is read-only; never retry a removal.
    let plan
    try { plan = JSON.parse(String(result.stdout || '')) } catch { continue }
    if (plan.local_build !== LOCAL_BUILD) throw new Error('Niezgodne pliki Local — usuwanie zablokowane. Zaktualizuj plugin.js, probe.py i manage.py.')
    if (plan.error || plan.account_key !== match[1] || !/^[a-f0-9]{64}$/.test(plan.revision || '') || !Array.isArray(plan.entries) || !plan.entries.length || plan.entries.length > 4
      || plan.entries.some(row => !/^[a-f0-9]{6,64}$/.test(row.id) || /^\d+$/.test(row.id))) throw new Error('Nie można bezpiecznie zidentyfikować własnych wpisów tego profilu. Nic nie usunięto.')
    return { ...plan, remove: async ids => {
      if (!ids.length || ids.some(id => !plan.entries.some(row => row.id === id))) throw new Error('Nieprawidłowy wybór wpisów.')
      // Exactly one mutation request; even timeouts must not auto-retry.
      const response = await target.request('shell.exec', { command: `${command} --credential-remove=${match[1]} --credential-ids=${ids.join(',')} --credential-revision=${plan.revision}` })
      if (!response || response.code) throw new Error('CLI nie potwierdziło operacji. Nie ponawiaj bez sprawdzenia puli.')
      const outcome = JSON.parse(String(response.stdout || ''))
      if (outcome.local_build !== LOCAL_BUILD || !Array.isArray(outcome.removed_ids)) throw new Error('Brak poprawnego odczytu po operacji. Sprawdź pulę.')
      return outcome
    } }
  }
  throw new Error('Nie znaleziono działającego probe.py Local do bezpiecznego odczytu wpisów.')
}

function CredentialRemoval({ accountKey, alias, snap, removalContext }) {
  const [plan, setPlan] = useState(null)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const lock = useRef(false)
  const selected = plan ? choice === 'all' ? plan.entries : plan.entries.filter(row => row.id === choice) : []
  const prepare = async () => {
    if (lock.current || !removalContext || removalContext.blocked) return
    lock.current = true; setBusy(true); setMessage('')
    try {
      const next = await prepareCredentialRemoval({ accountKey, ...removalContext })
      setPlan(next); setChoice(next.entries[0].id)
    } catch { setMessage('Nie można bezpiecznie ustalić wpisów konta. Usuwanie zablokowane; wpisy odziedziczone lub niejednoznaczne pozostają tylko do odczytu.') }
    finally { lock.current = false; setBusy(false) }
  }
  const confirm = async () => {
    if (lock.current || !plan || !selected.length || !removalContext || removalContext.blocked) return
    lock.current = true; setBusy(true)
    try {
      const outcome = await plan.remove(selected.map(row => row.id))
      const count = outcome.removed_ids.length
      const note = outcome.ok ? `Usunięto z puli Hermesa: ${count} wpisów (potwierdzono odczytem).` : `${outcome.partial ? 'Częściowe usunięcie' : 'Brak pełnego potwierdzenia'}: ${count}/${selected.length}. Sprawdź odświeżoną pulę przed ponowieniem.`
      setMessage(note)
      if (typeof host.notify === 'function') host.notify({ kind: outcome.ok ? 'success' : 'error', message: note })
    } catch { setMessage('Wynik usuwania niepewny. Nie ponawiaj automatycznie; sprawdź odświeżoną pulę.') }
    finally {
      setPlan(null); lock.current = false; setBusy(false)
      // Refresh the entire roster, even after a partial failure; no cooldown gate.
      try { await removalContext.onRefresh() } catch { setMessage('Operacja zakończona, ale odświeżenie puli nie powiodło się. Odśwież ręcznie przed kolejną operacją.') }
    }
  }
  return jsxs('div', { 'data-credential-management': true, style: { fontSize: '0.75rem' }, children: [
    jsx(SmallButton, { disabled: busy || !removalContext || removalContext.blocked || !/^openai-codex:[a-f0-9]{20}$/.test(accountKey), onClick: prepare, children: busy ? 'Czekaj…' : 'Usuń z puli Hermesa' }),
    plan ? jsxs('div', { role: 'alertdialog', 'aria-modal': false, 'aria-label': 'Potwierdź usunięcie z puli Hermesa', style: { padding: 10, marginTop: 6, border: '1px solid var(--ui-stroke-secondary)', borderRadius: 6, color: text.primary }, children: [
      jsx('strong', { children: `Usuń z puli Hermesa: ${alias || snapshotAccountLabel(snap)} (${snapshotAccountLabel(snap) || 'konto'}, ${accountKey})` }),
      jsx('p', { children: `Profil: ${removalContext.profile}. To NIE usuwa konta OpenAI ani subskrypcji. Usunięcie zapisanych poświadczeń jest nieodwracalne — przywrócenie wymaga ponownego logowania. Hermes CLI może również wyczyścić zapis logowania Codex w Hermesie i zablokować ponowny import tego źródła; pliki Codex CLI pozostają nietknięte.` }),
      plan.entries.length > 1 ? jsx('select', { 'aria-label': 'Wpisy do usunięcia', value: choice, disabled: busy, onChange: event => setChoice(event.target.value), children: [
        ...plan.entries.map(row => jsx('option', { value: row.id, children: `Wpis ${row.id} · ${row.source} · ${row.state}` }, row.id)),
        plan.all_allowed ? jsx('option', { value: 'all', children: `Wszystkie wpisy tego konta (${plan.entries.length})` }) : null
      ] }) : null,
      jsx('p', { children: 'Dokładnie te wpisy zostaną usunięte:' }),
      jsx('ul', { children: selected.map(row => jsx('li', { children: `${row.id} · ${row.source} · ${row.state}` }, row.id)) }),
      jsx('button', { type: 'button', disabled: busy || !removalContext || removalContext.blocked, onClick: confirm, style: { color: text.red, background: 'transparent', border: '1px solid var(--ui-stroke-secondary)', padding: '4px 8px', borderRadius: 4 }, children: 'Potwierdzam — usuń zapisane poświadczenia' }),
      jsx(SmallButton, { disabled: busy, onClick: () => { setPlan(null); setChoice(''); setMessage('') }, children: 'Anuluj' })
    ] }) : null,
    message ? jsx('p', { role: 'status', children: message }) : null
  ] })
}

function AccountOverviewRow({ snap, nowMs, accountKey, refreshAccount, refreshDisabled, busyAccount, removalContext }) {
  const t = useLocalText()
  const [expanded, setExpanded] = useState(false)
  const aliases = useValue($accountAliases)
  // Never bind an alias to a masked-label fallback or an unscoped unknown.
  const aliasKey = String(snap.account_key || '').trim() ? accountKey : ''
  const alias = aliasKey && aliases[aliasKey] || ''
  const status = deriveAccountStatus(snap, nowMs)
  const { state, auth, freshness, availability, blockScope } = status
  const key = snapshotAccountKey(snap)
  const detailId = `resetwatch-local-details-${encodeURIComponent(key)}`
  return jsxs(Fragment, { children: [
    jsxs('tr', { 'data-account-row': key || 'unknown', 'data-account-status': state, children: [
      jsxs('td', { style: overviewCellStyle, children: [
        jsxs('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline', whiteSpace: 'nowrap', lineHeight: '20px' }, children: [
          jsx('strong', { title: alias || undefined, style: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }, children: alias || snapshotAccountLabel(snap) || familyTitle(snap.provider) })
        ] }),
        jsx('div', { 'data-auth-health': auth, title: authStatusTitle(auth, t), style: { fontSize: '13px', lineHeight: '18px', whiteSpace: 'nowrap', color: auth === 'revoked' ? text.red : text.secondary }, children: t(`short_${auth}`) })
      ] }),
      jsx(OverviewQuota, { snap, label: 'Session', state, freshness, nowMs }),
      jsx(OverviewQuota, { snap, label: 'Weekly', state, freshness, nowMs }),
      jsxs('td', { style: overviewCellStyle, children: [
        jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 6, lineHeight: '20px' }, children: [
          jsx('span', { 'data-quota-availability': availability, title: `${t(availability)} · ${t('freshnessHelp')}`, style: { whiteSpace: 'nowrap', color: availability === 'limit_reached' ? text.red : text.secondary, fontSize: '13px' }, children: quotaStatusLabel(availability, t, blockScope) }),
          jsx('button', { type: 'button', 'data-account-toggle': key || 'unknown', 'aria-expanded': expanded, 'aria-controls': detailId,
            onClick: () => setExpanded(value => !value),
            style: { border: 0, background: 'transparent', color: text.accent, padding: 0, cursor: 'pointer', fontSize: '13px', lineHeight: '18px', whiteSpace: 'nowrap' },
            children: `${expanded ? '▾' : '▸'} ${t(expanded ? 'closeDetails' : 'details')}` })
        ] }),
        jsx('span', { 'data-quota-freshness': freshness, title: `${t('observed')}: ${observedMillis(snap.fetched_at) ? new Date(observedMillis(snap.fetched_at)).toLocaleString() : t('never')} · ${t('freshnessHelp')}`, style: { display: 'block', color: text.secondary, fontSize: '13px', lineHeight: '20px', whiteSpace: 'nowrap' }, children: `${compactObservation(snap.fetched_at, nowMs, t)} · ${freshnessLabel(freshness, t)}` })
        , blockScope ? jsx('span', { style: { display: 'block', fontSize: '13px', lineHeight: '18px', color: text.secondary }, children: recoveryLabel(status, nowMs, t) }) : null
      ] })
    ] }),
    expanded ? jsx('tr', { id: detailId, 'data-account-details': key || 'unknown', children: jsx('td', { colSpan: 4, style: { ...overviewCellStyle, padding: 10 }, children: jsxs('div', {
      style: { display: 'flex', flexDirection: 'column', gap: 6, whiteSpace: 'normal' }, children: [
        jsx(AccountAliasEditor, { accountKey: aliasKey, alias }),
        jsx(CredentialRemoval, { accountKey, alias, snap, removalContext }, JSON.stringify([removalContext && removalContext.connectionId, removalContext && removalContext.profile, removalContext && removalContext.sessionId, accountKey])),
        jsx(SmallButton, { disabled: refreshDisabled || !/^openai-codex:[a-f0-9]{20}$/.test(accountKey) || !refreshAccount,
          title: refreshDisabled ? t('cooldown') : t('guidance'), onClick: () => refreshAccount(accountKey),
          children: busyAccount === accountKey ? `↻ ${t('refreshing')}` : t('checkAccount') }),
        jsx(AccountStatusCard, { snap, nowMs }),
        ...(snap.details || []).map((detail, index) => jsx('div', { style: { color: text.tertiary, fontSize: '0.75rem', overflowWrap: 'anywhere' }, children: detail }, index)),
        (snap.windows || []).length ? jsx('div', { style: { overflowX: 'auto' }, children: jsxs('table', {
          style: { width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }, children: [
            jsx('thead', { children: jsx('tr', { children: [t('windows'), t('remainingMode'), t('usedMode'), t('reset')].map(label => jsx('th', { scope: 'col', style: overviewCellStyle, children: label }, label)) }) }),
            jsx('tbody', { children: snap.windows.map((window, index) => jsxs('tr', { children: [
              jsx('td', { style: overviewCellStyle, children: quotaWindowLabel(window.label, t) }),
              jsx('td', { style: overviewCellStyle, children: quotaPercent({ remaining: window.remaining_percent, used: window.used_percent }, 'remaining') ?? '—' }),
              jsx('td', { style: overviewCellStyle, children: quotaPercent({ remaining: window.remaining_percent, used: window.used_percent }, 'used') ?? '—' }),
              jsxs('td', { style: overviewCellStyle, children: [
                window.reset_at && Number.isFinite(Date.parse(window.reset_at)) ? new Date(window.reset_at).toLocaleString() : '—',
                window.detail ? jsx('div', { style: { color: text.tertiary }, children: window.detail }) : null
              ] })
            ] }, index)) })
          ]
        }) }) : null
      ] }) }) }) : null
  ] })
}

function AccountOverviewTable({ accounts, nowMs, accountSort, refreshAccount, refreshDisabled, busyAccount, removalContext }) {
  const t = useLocalText()
  return jsxs('div', { 'data-account-overview': true, style: { overflowX: 'auto', width: '100%', minWidth: 0 }, children: [
    jsx('style', { children: '.resetwatch-local-account-table > tbody > tr[data-account-row]:hover > td { background-color: color-mix(in srgb, var(--ui-text-primary) 5%, transparent); }' }),
    jsxs('table', { className: 'resetwatch-local-account-table',
    'aria-label': `Codex · ${t('heading')}`, style: { width: '100%', minWidth: 960, tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: '15px', lineHeight: '20px' }, children: [
      jsx('colgroup', { children: [['account', '20%'], ['session', '24%'], ['weekly', '29%'], ['observation', '27%']]
        .map(([column, width]) => jsx('col', { 'data-account-column': column, style: { width } }, column)) }),
      jsx('thead', { children: jsx('tr', { children: ['account', 'session', 'weekly', 'observation'].map(label => jsx('th', {
        scope: 'col', style: { ...overviewCellStyle, padding: '5px 8px', color: text.secondary, fontWeight: 500, whiteSpace: 'nowrap' }, children: label === 'weekly' && [...accounts.values()].some(account => (account.snap.windows || []).some(window => window.label === '30 days')) ? 'Tydzień / 30 dni' : t(label)
      }, label)) }) }),
      jsx('tbody', { children: sortAccounts(accounts, accountSort, nowMs).map(([key, account]) => jsx(AccountOverviewRow, { snap: account.snap, nowMs, accountKey: key, refreshAccount, refreshDisabled, busyAccount, removalContext }, key)) })
    ]
  })] })
}

function ProviderBlock({ title, cards, nowMs, empty, actionsFor, accountSort, refreshAccount, refreshDisabled, busyAccount, removalContext }) {
  const [open, toggle] = useSectionOpen(`provider:${title}`)
  const t = useLocalText()
  const accounts = new Map()
  for (const card of cards) {
    if (!card.snapshot || !card.snapshot.account_status) continue
    if (!accounts.has(card.accountKey)) accounts.set(card.accountKey, { snap: card.snapshot, cards: [] })
    accounts.get(card.accountKey).cards.push(card)
  }
  const renderCard = card => jsx(LimitCard, { card, nowMs, actions: actionsFor ? actionsFor(card) : null }, card.id)
  return jsxs('section', {
    style: { display: 'flex', flexDirection: 'column', gap: 8 },
    children: [
      jsx(SectionHeader, { title: accounts.size ? `${title} · ${accounts.size} ${t('count')}` : title, open, onToggle: toggle }),
      !open
        ? null
        : !cards.length
          ? jsx('div', { style: { fontSize: '0.8125rem', color: text.tertiary }, children: empty })
          : accounts.size && [...accounts.values()].every(account => providerKey(account.snap.provider) === 'openai-codex')
            ? jsx(AccountOverviewTable, { accounts, nowMs, accountSort, refreshAccount, refreshDisabled, busyAccount, removalContext })
            : accounts.size
            ? sortAccounts(accounts, accountSort, nowMs).map(([key, account]) => jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: [
                jsx(AccountStatusCard, { snap: account.snap, nowMs }),
                (account.snap.windows || []).length ? jsxs('details', { open: true, children: [
                  jsx('summary', { style: { cursor: 'pointer', color: text.secondary, fontSize: '0.75rem' }, children: t('windows') }),
                  ...account.cards.map(renderCard)
                ] }) : null
              ] }, key))
            : cards.map(renderCard)
    ]
  })
}

function ClockForm({ onSave, onCancel }) {
  const t = useLocalText()
  const [presetId, setPresetId] = useState('gemini')
  const preset = PRESETS.find(item => item.id === presetId) || PRESETS[0]
  const [name, setName] = useState(preset.name)
  const [left, setLeft] = useState('70')
  const [resetLocal, setResetLocal] = useState('')
  const [url, setUrl] = useState(preset.url)

  useEffect(() => {
    const next = PRESETS.find(item => item.id === presetId) || PRESETS[0]
    if (presetId !== 'custom') {
      setName(next.name)
      setUrl(next.url)
    }
  }, [presetId])

  const remaining = clampPercent(left)
  const canSave = Boolean(name.trim()) && remaining !== null

  return jsxs('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      padding: 12,
      borderRadius: 10,
      border: '1px solid var(--ui-stroke-secondary)'
    },
    children: [
      jsxs('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 }, children: [
        PRESETS.map(item =>
          jsx(
            SmallButton,
            {
              active: presetId === item.id,
              onClick: () => {
                tap()
                setPresetId(item.id)
              },
              children: item.id === 'custom' ? t('custom') : item.name
            },
            item.id
          )
        )
      ] }),
      jsxs('div', { style: { display: 'grid', gridTemplateColumns: '1fr 90px 1fr', gap: 8 }, children: [
        jsx(Field, { label: t('name'), children: jsx(NativeInput, { value: name, onChange: setName, placeholder: t('planName') }) }),
        jsx(Field, {
          label: t('remainingMode'),
          children: jsx(NativeInput, { value: left, onChange: setLeft, type: 'number', placeholder: '70' })
        }),
        jsx(Field, {
          label: t('reset'),
          children: jsx(NativeInput, { value: resetLocal, onChange: setResetLocal, type: 'datetime-local' })
        })
      ] }),
      jsx(Field, {
        label: t('dashboardUrl'),
        children: jsx(NativeInput, { value: url, onChange: setUrl, placeholder: 'https://' })
      }),
      jsxs('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' }, children: [
        jsx(SmallButton, { onClick: onCancel, children: t('cancel') }),
        jsx(SmallButton, {
          active: true,
          disabled: !canSave,
          onClick: () => {
            if (!canSave) return
            tap()
            onSave({
              id: newClockId(),
              name: name.trim(),
              remaining,
              resetAt: fromDatetimeLocal(resetLocal),
              url: url.trim()
            })
          },
          children: t('addClock')
        })
      ] })
    ]
  })
}

function EditClock({ clock, onSave, onCancel }) {
  const t = useLocalText()
  const [name, setName] = useState(clock.name)
  const [left, setLeft] = useState(String(clock.remaining))
  const [resetLocal, setResetLocal] = useState(toDatetimeLocal(clock.resetAt))
  const [url, setUrl] = useState(clock.url || '')
  const remaining = clampPercent(left)
  const canSave = Boolean(name.trim()) && remaining !== null
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220 },
    children: [
      jsx(NativeInput, { value: name, onChange: setName }),
      jsxs('div', { style: { display: 'flex', gap: 8 }, children: [
        jsx(NativeInput, { value: left, onChange: setLeft, type: 'number', style: { width: 72 } }),
        jsx(NativeInput, { value: resetLocal, onChange: setResetLocal, type: 'datetime-local' })
      ] }),
      jsx(NativeInput, { value: url, onChange: setUrl, placeholder: 'https://' }),
      jsxs('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' }, children: [
        jsx(SmallButton, { onClick: onCancel, children: t('cancel') }),
        jsx(SmallButton, {
          active: true,
          disabled: !canSave,
          onClick: () => {
            if (!canSave) return
            onSave({ ...clock, name: name.trim(), remaining, resetAt: fromDatetimeLocal(resetLocal), url: url.trim() })
          },
          children: t('save')
        })
      ] })
    ]
  })
}

function useLiveCardsPolled(gateway, sessionId, connectionId, profile, disabled = []) {
  const sid = sessionId || ''
  const selection = disabled.join(',')
  const [data, setData] = useState({ cards: [], errors: [], hadSession: false, haveAccountRpc: false })
  const [isFetching, setFetching] = useState(false)
  const genRef = useRef(0)
  const inFlight = useRef(false)

  const load = (opts) => {
    if (gateway !== 'open' || inFlight.current) return
    inFlight.current = true
    const gen = ++genRef.current
    setFetching(true)
    return fetchLiveCards(sid, { ...opts, disabled }, connectionId, profile)
      .then(next => {
        if (gen !== genRef.current) return
        setData(previous => opts && opts.accountKey ? mergeAccountRefresh(previous, next, opts.accountKey) : next)
      })
      .catch(error => {
        if (gen !== genRef.current) return
        if (opts && opts.accountKey) {
          setData(previous => ({ ...previous, errors: [errorMessage(error, 'Account refresh failed')] }))
          return
        }
        setData({
          cards: [],
          errors: [errorMessage(error, 'Could not read live usage')],
          hadSession: Boolean(sid),
          haveAccountRpc: false
        })
      })
      .finally(() => {
        if (gen !== genRef.current) return
        inFlight.current = false
        setFetching(false)
      })
  }

  useEffect(() => {
    setData({ cards: [], errors: [], hadSession: Boolean(sid), haveAccountRpc: false })
    load()
    const id = setInterval(() => load(), POLL_MS)
    return () => {
      genRef.current += 1
      // A fetch from the old session may still be running. Its result is
      // discarded above, so it must not block the first load of the new one.
      inFlight.current = false
      clearInterval(id)
    }
  }, [gateway, sid, connectionId, profile, selection])

  return { data, isFetching, refetch: accountKey => load({ fresh: true, accountKey }) }
}

function useLiveCardsQuery(gateway, sessionId, connectionId, profile, disabled = []) {
  const sid = sessionId || ''
  const key = [PLUGIN_ID, 'live', connectionId, profile || '', sid]
  if (disabled.length) key.push(disabled.join(','))
  const contextKey = JSON.stringify(key)
  const [manual, setManual] = useState({ key: '', fetching: false, error: '' })
  const inFlight = useRef(false)
  const manualFetching = manual.key === contextKey && manual.fetching
  const manualError = manual.key === contextKey ? manual.error : ''
  const query = useQuery({
    queryKey: key,
    // Do not toggle enabled for a targeted read: re-enabling a stale query
    // would immediately fetch every account and defeat exact targeting.
    queryFn: () => inFlight.current === contextKey && queryClient && typeof queryClient.getQueryData === 'function'
      ? queryClient.getQueryData(key) || { cards: [], errors: [] }
      : fetchLiveCards(sid, { disabled }, connectionId, profile),
    enabled: gateway === 'open',
    refetchInterval: manualFetching ? false : POLL_MS,
    retry: false
  })
  const refetch = accountKey => {
    if (inFlight.current || query.isFetching || gateway !== 'open') return null
    if (!queryClient || typeof queryClient.fetchQuery !== 'function') {
      // Never turn an individual request into a bulk refresh on older SDKs.
      return !accountKey && query.refetch ? query.refetch() : null
    }
    inFlight.current = contextKey
    setManual({ key: contextKey, fetching: true, error: '' })
    return Promise.resolve(typeof queryClient.cancelQueries === 'function' ? queryClient.cancelQueries({ queryKey: key, exact: true }) : null)
      .then(() => queryClient
      .fetchQuery({
        queryKey: [...key, 'fresh', accountKey || 'all'],
        queryFn: () => fetchLiveCards(sid, { fresh: true, disabled, accountKey }, connectionId, profile),
        staleTime: 0,
        retry: false
      }))
      .then(data => {
        queryClient.setQueryData(key, previous => accountKey ? mergeAccountRefresh(previous, data, accountKey) : data)
        setManual(previous => previous.key === contextKey ? { key: contextKey, fetching: false, error: '' } : previous)
        return data
      })
      .catch(error => {
        // Keep the last good cards, but say the refresh did not land.
        setManual(previous => previous.key === contextKey
          ? { key: contextKey, fetching: false, error: errorMessage(error, 'Refresh failed') }
          : previous)
        return null
      })
      .finally(() => { if (inFlight.current === contextKey) inFlight.current = false })
  }
  let data = query.data
  if (query.error) {
    const base = data || { cards: [], errors: [], hadSession: Boolean(sid), haveAccountRpc: false }
    data = { ...base, errors: [...(base.errors || []), errorMessage(query.error, 'Could not read live usage')] }
  }
  if (manualError) {
    const base = data || { cards: [], errors: [], hadSession: false, haveAccountRpc: false }
    data = { ...base, errors: [...(base.errors || []), `Refresh failed: ${manualError}`] }
  }
  return { data, isFetching: !!(query.isFetching || manualFetching), refetch }
}

const useLiveCards = typeof useQuery === 'function' ? useLiveCardsQuery : useLiveCardsPolled

function groupLiveCards(cards) {
  const groups = []
  const index = new Map()
  for (const card of cards || []) {
    const key = card.group || card.provider || 'Account'
    if (!index.has(key)) {
      const group = { title: key, cards: [] }
      index.set(key, group)
      groups.push(group)
    }
    index.get(key).cards.push(card)
  }
  return groups
}

function PluginPageContent() {
  const t = useLocalText()
  const gateway = useValue(host.state.gateway)
  const nowMs = useValue($now)
  const clocks = useValue($clocks)
  const sessionId = useValue(host.state.focusedSessionId)
  const owner = useValue(host.state.focusedSessionOwner || $missingState)
  const focusedProfile = useValue(host.state.focusedSessionProfile || $missingState)
  const activeConnectionId = useValue(host.state.connectionId || $missingState)
  const activeProfile = useValue(host.state.profile || $missingState)
  const hasOwnerState = !!host.state.focusedSessionOwner
  // A null owner means Desktop could not place the focused session. Do not
  // combine its profile with another connection's account.
  const unresolved = hasOwnerState
    ? !owner || !owner.connectionId || !owner.profile
    : focusedProfile && focusedProfile !== activeProfile
  const connectionId = unresolved ? null : hasOwnerState ? owner.connectionId : activeConnectionId || ''
  const profile = hasOwnerState ? owner && owner.profile : focusedProfile || activeProfile
  const preferences = useValue($providerPreferences)
  const displayMode = useValue($displayMode)
  useValue($viewModes)
  const mode = viewModeFor(connectionId, profile)
  const codexOnly = mode === 'codex'
  const effectivePreferences = effectiveProviderPreferences(preferences, mode)
  const live = useLiveCards(gateway, sessionId, connectionId, profile, effectivePreferences.disabled)
  useValue($accountSortPreferences)
  const accountSort = accountSortFor(connectionId, profile)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [liveOpen, toggleLive] = useSectionOpen('live')
  const [manualOpen, toggleManual] = useSectionOpen('manual')
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [cooldownTick, setCooldownTick] = useState(0)
  const [busy, setBusy] = useState({ scope: '', accountKey: '' })
  const refreshLock = useRef(false)
  const refreshScope = JSON.stringify([connectionId, profile, sessionId, effectivePreferences.disabled])
  const busyAccount = busy.scope === refreshScope ? busy.accountKey : ''
  const coolingDown = cooldownUntil > Date.now()
  const payload = live.data || { cards: [], errors: [], hadSession: false }
  const groups = useMemo(
    () => groupLiveCards(arrangeProviderCards(payload.cards, effectivePreferences)
      .filter(card => !codexOnly || cardProvider(card) === 'openai-codex')).filter(group => group.cards.length),
    [payload.cards, preferences, mode]
  )

  useEffect(() => {
    $now.set(Date.now())
    const id = setInterval(() => $now.set(Date.now()), 30000)
    const resumed = () => $now.set(Date.now())
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resumed)
    return () => {
      clearInterval(id)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resumed)
    }
  }, [])

  const refreshAfterRemoval = async () => {
    // A poll already in flight must finish before the post-mutation roster read.
    for (let attempt = 0; attempt < 35; attempt++) {
      const result = live.refetch()
      if (result) {
        const refreshed = await result
        if (refreshed === null) throw new Error('Roster refresh failed')
        return
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error('Roster refresh remained busy')
  }

  const startRefresh = accountKey => {
    if (refreshLock.current || live.isFetching || cooldownUntil > Date.now() || gateway !== 'open' || connectionId === null) return false
    const result = live.refetch && live.refetch(accountKey)
    if (!result) return false
    refreshLock.current = true
    setBusy({ scope: refreshScope, accountKey: accountKey || '*' })
    setCooldownUntil(Date.now() + REFRESH_COOLDOWN_MS)
    Promise.resolve(result).catch(() => null).finally(() => {
      refreshLock.current = false
      setBusy(previous => previous.scope === refreshScope ? { scope: '', accountKey: '' } : previous)
    })
    return true
  }

  useEffect(() => {
    if (gateway !== 'open' || connectionId === null || live.isFetching || refreshLock.current
      || typeof document !== 'undefined' && document.visibilityState === 'hidden') return undefined
    const plan = resetRefreshPlan(payload.cards, Date.now(), resetRefreshAttempts, cooldownUntil, refreshScope)
    if (!plan) return undefined
    const id = setTimeout(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const due = resetRefreshPlan(payload.cards, Date.now(), resetRefreshAttempts, cooldownUntil, refreshScope)
      if (!due || due.at > Date.now() || !startRefresh()) return
      due.keys.forEach(key => resetRefreshAttempts.add(key))
      while (resetRefreshAttempts.size > 1024) resetRefreshAttempts.delete(resetRefreshAttempts.values().next().value)
    }, Math.min(2147483647, Math.max(0, plan.at - Date.now())))
    return () => clearTimeout(id)
  }, [payload.cards, gateway, connectionId, live.isFetching, cooldownUntil, refreshScope, nowMs])

  // Re-enable the Refresh button exactly when the cooldown ends.
  useEffect(() => {
    const wait = cooldownUntil - Date.now()
    if (wait <= 0) return undefined
    const id = setTimeout(() => setCooldownTick(tick => tick + 1), wait + 50)
    return () => clearTimeout(id)
  }, [cooldownUntil, cooldownTick])

  const openExternal = url => {
    if (!isHttpUrl(url)) return
    tap()
    if (os && typeof os.openExternal === 'function') os.openExternal(url)
  }

  const clockCards = clocks.map(clock => ({
    id: clock.id,
    source: 'manual',
    provider: clock.name,
    label: clock.name,
    remaining: clock.remaining,
    used: remainingFromUsed(clock.remaining),
    resetAt: clock.resetAt,
    resetText: '',
    detail: clock.url ? clock.url.replace(/^https?:\/\//, '') : t('manualNote'),
    url: clock.url
  }))

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
    children: [
      jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
          padding: '10px 16px 6px',
          width: '100%',
          maxWidth: '100%',
          boxSizing: 'border-box',
          borderBottom: '1px solid var(--ui-stroke-secondary)'
        },
        children: [
          jsx('h1', { style: { fontSize: '1rem', fontWeight: 600, color: text.primary, margin: 0 }, children: PLUGIN_NAME }),

          jsxs('div', {
            style: { marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
            children: [
              jsx(AccountSortControls, { connectionId, profile }, accountSortScope(connectionId, profile)),
              jsxs('select', {
                'aria-label': t('displayMode'),
                value: displayMode,
                onChange: event => saveDisplayMode(event.target.value),
                style: nativeSelectStyle,
                children: [
                  jsx('option', { value: 'remaining', style: nativeOptionStyle, children: t('remainingMode') }),
                  jsx('option', { value: 'used', style: nativeOptionStyle, children: t('usedMode') })
                ]
              }),
              jsx('span', {
                style: { fontSize: '0.6875rem', color: text.tertiary },
                children: `${t('gateway')}: ${t(`gateway_${gateway || 'idle'}`) === `gateway_${gateway || 'idle'}` ? gateway : t(`gateway_${gateway || 'idle'}`)}`
              }),
              jsx(SmallButton, {
                disabled: !!live.isFetching || coolingDown || gateway !== 'open' || connectionId === null,
                title: coolingDown ? t('cooldown') : t('guidance'),
                onClick: () => {
                  if (startRefresh()) tap()
                },
                children: live.isFetching ? t('refreshing') : t('check')
              })
            ]
          })
        ]
      }),
      jsxs('div', {
        style: {
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '10px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10
        },
        children: [
          jsxs('section', {
            style: { display: 'flex', flexDirection: 'column', gap: 12 },
            children: [
              jsx(SectionHeader, {
                title: t('automatic'),
                open: liveOpen,
                onToggle: toggleLive
              }),
              !liveOpen
                ? null
                : jsxs('div', {
                    style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
                    children: [
                      groups.length
                        ? jsx('div', {
                            style: {
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 12,
                              minWidth: 0
                            },
                            children: groups.map(group =>
                              jsx(ProviderBlock, { title: group.title, cards: group.cards, nowMs, accountSort,
                                refreshAccount: accountKey => { if (startRefresh(accountKey)) tap() },
                                refreshDisabled: !!live.isFetching || coolingDown || gateway !== 'open' || connectionId === null, busyAccount,
                                removalContext: gateway === 'open' && connectionId !== null ? { connectionId, profile, sessionId, blocked: !!live.isFetching, onRefresh: refreshAfterRemoval } : null }, group.title)
                            )
                          })
                        : jsx('div', {
                            style: { fontSize: '0.8125rem', color: text.tertiary },
                            children: effectivePreferences.disabled.length === LIVE_PROVIDERS.length
                              ? t('emptyProviders')
                              : t('emptyUsage')
                          }),
                      payload.errors && payload.errors.length
                        ? jsx('div', {
                            style: { fontSize: '0.75rem', color: text.tertiary },
                            children: payload.errors.join(' · ')
                          })
                        : null
                    ]
                  })
            ]
          }),
          jsx(ProviderControls, { preferences, connectionId, profile, mode }, accountSortScope(connectionId, profile)),
          jsxs('details', { children: [
            jsx('summary', { style: { cursor: 'pointer', color: text.secondary, fontSize: '0.75rem' }, children: t('helpHeading') }),
            jsx('p', { style: { margin: '6px 0', fontSize: '0.75rem', color: text.tertiary, lineHeight: 1.45 }, children: `${t('help')} ${t('guidance')}` })
          ] }),
          codexOnly ? null : jsxs('section', {
            style: { display: 'flex', flexDirection: 'column', gap: 8 },
            children: [
              jsx(SectionHeader, {
                title: t('manualHeading'),
                open: manualOpen,
                onToggle: toggleManual,
                extra: jsx(SmallButton, {
                  active: adding,
                  onClick: () => {
                    tap()
                    if (!manualOpen) toggleManual()
                    setAdding(open => !open)
                  },
                  children: adding ? t('close') : t('addClock')
                })
              }),
              !manualOpen || !adding
                ? null
                : jsx(ClockForm, {
                    onSave: clock => {
                      saveClocks([...clocks, clock])
                      setAdding(false)
                    },
                    onCancel: () => setAdding(false)
                  }),
              !manualOpen
                ? null
                : clockCards.map(card => {
                    const clock = clocks.find(item => item.id === card.id)
                    return editingId === card.id && clock
                      ? jsx(
                          EditClock,
                          {
                            clock,
                            onSave: next => {
                              saveClocks(clocks.map(item => (item.id === next.id ? next : item)))
                              setEditingId(null)
                            },
                            onCancel: () => setEditingId(null)
                          },
                          card.id
                        )
                      : jsx(
                          LimitCard,
                          {
                            card,
                            nowMs,
                            actions: jsxs('div', {
                              style: { display: 'flex', gap: 6 },
                              children: [
                                isHttpUrl(card.url)
                                  ? jsx(SmallButton, {
                                      onClick: () => openExternal(card.url),
                                      children: t('open')
                                    })
                                  : null,
                                jsx(SmallButton, {
                                  onClick: () => {
                                    tap()
                                    setEditingId(card.id)
                                  },
                                  children: t('edit')
                                }),
                                jsx(SmallButton, {
                                  onClick: () => {
                                    tap()
                                    saveClocks(clocks.filter(item => item.id !== card.id))
                                  },
                                  children: t('remove')
                                })
                              ]
                            })
                          },
                          card.id
                        )
                  })
            ]
          }),
          jsx(AssistedCodexAdd, { connectionId, profile, sessionId,
            blocked: gateway !== 'open' || connectionId === null || !!live.isFetching,
            onRefresh: refreshAfterRemoval }, JSON.stringify([connectionId, profile, sessionId])),
        ]
      })
    ]
  })
}




function Page() {
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
    children: [
      jsx('div', { style: { flex: 1, minHeight: 0, overflow: 'hidden' }, children: jsx(PluginPageContent, {}) }),
      null
    ]
  });
}

export default {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: 'Separate read-only local copy: account health, observed quota and reset clocks. No token renewal or inference.',
  defaultEnabled: true,
  register(ctx) {
    const onDispose = typeof ctx.onDispose === 'function' ? fn => ctx.onDispose(fn) : () => {}
    storage = ctx.storage || null
    os = ctx.os || null
    if (ctx.i18n && typeof ctx.i18n.register === 'function') ctx.i18n.register(LOCAL_TEXT)
    loadClocks()
    loadAccountAliases()
    loadAccountSortPreferences()
    loadViewModes()
    $providerPreferences.set(normalizeProviderPreferences(stored('providers', {})))
    $displayMode.set(normalizeDisplayMode(stored('display_mode', 'remaining')))

    const contributions = [
      { id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => jsx(Page, {}) },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 62,
        data: { path: ROUTE, label: PLUGIN_NAME, codicon: 'watch' }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'resetwatch-local.open',
          label: `${PLUGIN_NAME}: ${localText()('open')}`,
          keywords: ['usage', 'quota', 'reset', 'limits', 'subscription'],
          run: () => go(ROUTE)
        }
      }
    ]
    if (KEYBINDS_AREA) {
      contributions.push({
        id: 'open-key',
        area: KEYBINDS_AREA,
        data: {
          id: 'resetwatch-local.open',
          label: `${localText()('open')} ${PLUGIN_NAME}`,
          category: PLUGIN_NAME,
          defaults: ['mod+alt+shift+r'],
          run: () => go(ROUTE)
        }
      })
    }
    ctx.registerMany(contributions)
    onDispose(() => {
      storage = null
      os = null
    })
  }
}
