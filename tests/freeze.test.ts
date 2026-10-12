import { expect, test } from 'claude-code/testing'
import type { CommandRunInput, On } from 'claude-code'

// What the person typing /freeze sends; the engine stamps origin and presentation.
const FREEZE = { command: 'freeze', args: '' } as CommandRunInput
const OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

// Stands in for the host. The freeze / thaw scripts clear and set the thaw
// file, the spawned wait ends once it is set, as the real child does, and
// every script and toast is recorded, state file writes apart (their argv
// whole). `waitExit` is the wait child's exit code (non-zero: the hold
// failed); `failFreeze` makes the freeze script fail, `failStateWrite` every
// state file write.
function fakeHost(on: On, { waitExit = 0, failFreeze = false, failStateWrite = false } = {}) {
  let isThawed = true
  const waiters: (() => void)[] = []
  const scripts: string[] = []
  const toasts: string[] = []
  const stateWrites: string[][] = []
  let markParked = () => {}
  const parked = new Promise<void>(resolve => {
    markParked = resolve
  })
  let markPaused = () => {}
  const paused = new Promise<void>(resolve => {
    markPaused = resolve
  })

  on('session.id', () => ({ value: 'freeze-test' }))
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 5, 8, 12) }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as { text?: string }).text ?? JSON.stringify(e)))

    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'test') {
      return { value: OK }
    }
    const script = e.argv[2] ?? ''
    if (script.includes('mktemp')) {
      stateWrites.push([...e.argv])

      return { value: failStateWrite ? { ...OK, exitCode: 1, stderr: 'read-only file system' } : OK }
    }
    if (script.includes('printf %s "$HOME"')) {
      return { value: { ...OK, stdout: '/home/test' } }
    }
    if (script.includes('kill -STOP')) {
      scripts.push('pause')
      markPaused()

      return { value: { ...OK, stdout: '2\n' } }
    }
    if (script.includes('kill -CONT')) {
      scripts.push('resume')
    } else if (script.includes('touch')) {
      scripts.push('thaw')
      isThawed = true
      waiters.splice(0).forEach(wake => wake())
    } else if (script.includes('rm -f')) {
      scripts.push('freeze')
      if (failFreeze) {
        return { value: { ...OK, exitCode: 1, stderr: 'disk full' } }
      }
      isThawed = false
    }

    return { value: OK }
  })
  on('process.spawn', async function* () {
    markParked()
    if (waitExit === 0 && !isThawed) {
      await new Promise<void>(resolve => waiters.push(resolve))
    }

    return { value: { code: waitExit, signal: null } }
  })

  return {
    parked,
    paused,
    scripts,
    toasts,
    stateWrites,
    states: () => stateWrites.map(argv => argv[5]),
  }
}

test('a tool call parks while frozen and runs once resumed', { timeoutMs: 10_000 }, async ($, on) => {
  const host = fakeHost(on)
  on('tool.call', () => ({ result: 'ran' }))

  await $.command.run(FREEZE)
  let isDone = false
  const call = $.tool.call({ tool: 'Bash', command: 'true' }).then(r => {
    isDone = true
    return r
  })

  await host.parked
  expect(isDone).toBe(false)

  expect((await $.command.run(FREEZE)).text).toBe('Resumed.')
  expect((await call).result).toBe('ran')
})

test('nothing parks when not frozen', async ($, on) => {
  fakeHost(on)
  on('tool.call', () => ({ result: 'ran' }))

  expect((await $.tool.call({ tool: 'Bash', command: 'true' })).result).toBe('ran')
})

test('/freeze toggles', async ($, on) => {
  fakeHost(on)

  expect((await $.command.run(FREEZE)).text).toContain('Freezing')
  expect((await $.command.run(FREEZE)).text).toBe('Resumed.')
})

const ON = { command: 'freeze', args: 'on' } as CommandRunInput
const OFF = { command: 'freeze', args: 'off' } as CommandRunInput

test('/freeze on and /freeze off are idempotent', { options: { pauseBackground: false } }, async ($, on) => {
  const host = fakeHost(on)

  expect((await $.command.run(OFF)).text).toBe('Not frozen.')
  expect((await $.command.run(ON)).text).toContain('Freezing')
  expect((await $.command.run(ON)).text).toBe('Already frozen · safe to disconnect.')
  expect((await $.command.run(OFF)).text).toBe('Resumed.')
  expect((await $.command.run(OFF)).text).toBe('Not frozen.')

  // One freeze, one resume (background tasks first, then the thaw file).
  expect(host.scripts).toEqual(['freeze', 'resume', 'thaw'])
})

test('/freeze on while still settling never cancels the freeze', { timeoutMs: 10_000, options: { pauseBackground: false } }, async ($, on) => {
  const host = fakeHost(on)
  let finish = () => {}
  const isFinished = new Promise<void>(resolve => {
    finish = resolve
  })
  let markStarted = () => {}
  const started = new Promise<void>(resolve => {
    markStarted = resolve
  })
  on('tool.call', async () => {
    markStarted()
    await isFinished

    return { result: 'ran' }
  })

  const call = $.tool.call({ tool: 'Bash', command: 'true' })
  await started
  await $.command.run(ON)
  expect((await $.command.run(ON)).text).toBe('Already freezing · 1 still running.')
  expect((await $.command.run({ command: 'freeze', args: ' ON ' } as CommandRunInput)).text).toContain('Already freezing')

  finish()
  expect((await call).result).toBe('ran')
  expect(host.scripts).toEqual(['freeze'])
})

test('the state file follows running, freezing, frozen and running again', { timeoutMs: 10_000, options: { pauseBackground: false } }, async ($, on) => {
  const host = fakeHost(on)
  let finish = () => {}
  const isFinished = new Promise<void>(resolve => {
    finish = resolve
  })
  let markStarted = () => {}
  const started = new Promise<void>(resolve => {
    markStarted = resolve
  })
  on('tool.call', async () => {
    markStarted()
    await isFinished

    return { result: 'ran' }
  })

  const call = $.tool.call({ tool: 'Bash', command: 'true' })
  await started
  await $.command.run(ON)
  expect(host.states()).toEqual(['running', 'freezing'])

  finish()
  await call
  expect(host.states()).toEqual(['running', 'freezing', 'frozen'])

  await $.command.run(OFF)
  expect(host.states()).toEqual(['running', 'freezing', 'frozen', 'running'])
})

test('state file writes run one fixed script, the session id and phase as arguments', { options: { pauseBackground: false } }, async ($, on) => {
  const host = fakeHost(on)

  await $.command.run(ON)
  await $.command.run(OFF)

  expect(host.stateWrites.length).toBeGreaterThan(0)
  const scripts = new Set(host.stateWrites.map(argv => argv[2]))
  expect(scripts.size).toBe(1)
  for (const argv of host.stateWrites) {
    expect(argv).toHaveLength(6)
    expect(argv.slice(0, 2)).toEqual(['sh', '-c'])
    expect(argv[4]).toBe('freeze-test')
    expect(['running', 'freezing', 'frozen']).toContain(argv[5])
  }
})

test('/freeze with anything else only shows the usage', async ($, on) => {
  const host = fakeHost(on)

  expect((await $.command.run({ command: 'freeze', args: 'onn' } as CommandRunInput)).text).toContain('Usage')
  expect((await $.command.run({ command: 'freeze', args: 'on; rm -rf ~' } as CommandRunInput)).text).toContain('Usage')

  expect(host.scripts).toEqual([])
  expect(host.stateWrites).toEqual([])
})

test('a freeze that fails says so, and the session keeps running', async ($, on) => {
  const host = fakeHost(on, { failFreeze: true })

  expect((await $.command.run(ON)).text).toBe('Could not freeze (disk full).')
  expect((await $.command.run(OFF)).text).toBe('Not frozen.')
  expect(host.states()).not.toContain('frozen')
})

test('a state file that cannot be written warns once and never blocks a freeze', { options: { pauseBackground: false } }, async ($, on) => {
  const host = fakeHost(on, { failStateWrite: true })
  on('tool.call', () => ({ result: 'ran' }))

  expect((await $.tool.call({ tool: 'Bash', command: 'true' })).result).toBe('ran')
  expect((await $.tool.call({ tool: 'Bash', command: 'true' })).result).toBe('ran')
  // One attempt for `running`, not one per tool call.
  expect(host.states()).toEqual(['running'])

  expect((await $.command.run(ON)).text).toContain('Freezing')
  expect((await $.command.run(OFF)).text).toBe('Resumed.')
  expect(host.states()).toEqual(['running', 'frozen', 'running'])
  expect(host.toasts.filter(t => t.includes('state file'))).toHaveLength(1)
})

test('a failed hold fails open and clears the frozen state', { timeoutMs: 10_000 }, async ($, on) => {
  fakeHost(on, { waitExit: 1 })
  on('tool.call', () => ({ result: 'ran' }))

  await $.command.run(FREEZE)
  expect((await $.tool.call({ tool: 'Bash', command: 'true' })).result).toBe('ran')
  // The state was cleared, so the next /freeze freezes again (not "Resumed").
  expect((await $.command.run(FREEZE)).text).toContain('Freezing')
})

test('a settled freeze pauses background tasks; resuming continues them before the turn', async ($, on) => {
  const host = fakeHost(on)

  await $.command.run(FREEZE)
  await host.paused
  await $.command.run(FREEZE)

  expect(host.scripts).toEqual(['freeze', 'pause', 'resume', 'thaw'])
})

test('with pauseBackground off, nothing is paused', { options: { pauseBackground: false } }, async ($, on) => {
  const host = fakeHost(on)

  await $.command.run(FREEZE)
  await $.command.run(FREEZE)

  expect(host.scripts).not.toContain('pause')
})

test('an MCP call failing on a dropped connection after a resume names the server', async ($, on) => {
  const host = fakeHost(on)
  on('tool.call', () => ({ isError: true, result: 'socket hang up' }))

  await $.command.run(FREEZE)
  await $.command.run(FREEZE)
  await $.tool.call({ tool: 'mcp__atlassian__getJiraIssue' })

  expect(host.toasts.some(t => t.includes('"atlassian"') && t.includes('/mcp'))).toBe(true)
})

const SPINNER = { word: 'Swooping', message: null, suffix: '…', mode: 'responding' } as const

test('once settled, the spinner and its timer give way to a static frozen line', async ($, on) => {
  const host = fakeHost(on)
  // The engine's own spinner line, timer included.
  on('ui.render', () => ({ type: 'Text', children: ['Swooping… (3m 1s)'] }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const before = await $.ui.mount({ plugin: 'freeze', surface, component: 'Spinner', props: SPINNER })
    expect(await before.find({ text: /Frozen since/ })).toBeUndefined()
  }

  await $.command.run(FREEZE)
  await host.paused
  for (const surface of ['terminal', 'desktop'] as const) {
    const frozen = await $.ui.mount({ plugin: 'freeze', surface, component: 'Spinner', props: SPINNER })
    expect(await frozen.find({ text: /^❄ Frozen since \d\d:\d\d · safe to disconnect.* · \/freeze to resume$/ })).toBeDefined()
  }
})

test('with the shortcut, the band is only the button while a turn runs, the full line when idle', { options: { shortcut: true } }, async ($, on) => {
  const host = fakeHost(on)
  on('ui.render', () => ({ type: 'Text', children: [''] }))
  const band = (isWorking: boolean) =>
    $.ui.mount({
      plugin: 'freeze',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking, maxRows: 10, bodyColumns: 100 } as never,
    })

  await $.command.run(FREEZE)
  await host.paused
  expect(await (await band(true)).find({ text: '❄ ctrl+x f resume' })).toBeDefined()
  expect(await (await band(false)).find({ text: /Frozen since .* · \/freeze or ctrl\+x f to resume$/ })).toBeDefined()
})

// A keybindings.json holding `existing`, and what the mod writes / sets.
function fakeShortcutHost(on: On, existing: unknown) {
  const writes: { path: string; text: string }[] = []
  const configs: { key: string; value: unknown }[] = []
  on('fs.read', () => ({ value: JSON.stringify(existing) }))
  on('fs.write', (_$, e) => {
    writes.push(e as { path: string; text: string })

    return { value: undefined }
  })
  on('config.set', (_$, e) => {
    configs.push({ key: e.key, value: e.value })

    return { value: e.value }
  })

  return { writes, configs }
}

const SHORTCUT_ON = { command: 'freeze', args: 'shortcut on' } as CommandRunInput

test('/freeze shortcut on merges the binding and turns the option on', async ($, on) => {
  fakeHost(on)
  const io = fakeShortcutHost(on, {
    bindings: [{ context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor' } }],
  })

  expect((await $.command.run(SHORTCUT_ON)).text).toContain('Shortcut on')
  expect(io.writes).toHaveLength(1)
  expect(io.writes[0]?.path).toBe('/home/test/.claude/keybindings.json')
  const written = JSON.parse(io.writes[0]?.text ?? '{}')
  expect(written.bindings[0].bindings).toEqual({
    'ctrl+e': 'chat:externalEditor',
    'ctrl+x f': 'app:cycleDiffBase',
  })
  expect(io.configs).toEqual([{ key: 'freeze.shortcut', value: true }])
})

test('/freeze shortcut on never takes over a key bound to something else', async ($, on) => {
  fakeHost(on)
  const io = fakeShortcutHost(on, { bindings: [{ context: 'Chat', bindings: { 'ctrl+x f': 'chat:stash' } }] })

  expect((await $.command.run(SHORTCUT_ON)).text).toContain('already bound to chat:stash')
  expect(io.writes).toHaveLength(0)
  expect(io.configs).toHaveLength(0)
})
