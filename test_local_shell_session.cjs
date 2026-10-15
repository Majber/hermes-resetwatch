const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const source = fs.readFileSync(path.join(__dirname, 'resetwatch-local/plugin.js'), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace('export default {', 'const plugin = {')
const atom = value => ({ get: () => value, set: next => { value = next } })

test('Local pins shell.exec to the requested session across snapshot pages and account refresh', async () => {
  const route = { connectionId: 'fixture-local', profile: 'default', targetProfile: 'default', mode: 'local' }
  const sessionId = 'fixture-runtime-session'
  const calls = []
  const token = 'a'.repeat(32)
  const snapshot = { provider: 'openai-codex', account: 'fixture.invalid',
    windows: [{ label: 'Session', remaining_percent: 77 }] }
  const host = {
    state: { focusedSessionId: atom('different-focused-session'), activeSessionId: atom('different-active-session') },
    profileRoutes: async () => [route],
    request: async () => { throw new Error('Unexpected unscoped RPC') },
    requestProfile: async (selected, method, params) => {
      assert.equal(selected, route)
      calls.push({ method, params })
      if (method === 'config.show') {
        assert.deepEqual(Object.keys(params), [])
        return { sections: [{ rows: [['Config File', '/fixture/hermes/config.yaml']] }] }
      }
      assert.equal(method, 'shell.exec', 'Only read-only probe RPCs are allowed')
      // CanonicalShellExecParams / gateway.session_shell.shell_exec: a sessionless
      // command is invalid_params, even while the gateway socket is connected.
      if (params.session_id !== sessionId) throw new Error('invalid_params')
      assert.deepEqual(Object.keys(params).sort(), ['command', 'session_id'])
      assert.ok(params.command.includes('/desktop-plugins/resetwatch-local/probe.py'))
      const next = params.command.includes('--snapshot-token=')
      assert.ok(params.command.includes(next ? `--snapshot-token=${token} --slice=1:8` : '--pin-snapshot --slice=0:8'))
      if (next) assert.ok(!params.command.includes(' --fresh'))
      host.state.focusedSessionId.set('focus-changed-during-read')
      return { code: 0, stderr: '', stdout: JSON.stringify({ snapshot_token: token,
        local_build: context.api.LOCAL_BUILD, snapshots: next ? [] : [snapshot] }) }
    }
  }
  const context = vm.createContext({ sdk: { host, atom }, console, URL })
  vm.runInContext(source + '\nglobalThis.api = { fetchLiveCards, LIVE_PROVIDERS, LOCAL_BUILD };', context)
  const disabled = context.api.LIVE_PROVIDERS.filter(key => key !== 'openai-codex')
  const full = await context.api.fetchLiveCards(sessionId, { disabled }, route.connectionId, route.profile)
  assert.equal(full.errors.length, 0, `No readings: ${full.errors.join(', ')}`)
  assert.equal(full.cards.length, 1)
  assert.equal(full.cards[0].remaining, 77)
  const targeted = await context.api.fetchLiveCards(sessionId,
    { disabled, accountKey: `openai-codex:${'b'.repeat(20)}` }, route.connectionId, route.profile)
  assert.equal(targeted.errors.length, 0)
  assert.equal(targeted.cards.length, 1)
  const shellCalls = calls.filter(call => call.method === 'shell.exec')
  assert.equal(shellCalls.length, 4, 'One initial and one pinned terminal page per read, without fallback attempts')
  assert.ok(shellCalls[2].params.command.includes(`--account-key=${'b'.repeat(20)}`))
  assert.ok(shellCalls[2].params.command.includes(' --fresh'))
})
