import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FreezeState } from '../types'

// The engine keybinding action the band's Button borrows: binding a chord to
// it in ~/.claude/keybindings.json ("Chat" context) presses the Button.
const KEY_ACTION = 'app:cycleDiffBase'
const KEY_LABEL = 'ctrl+x f'

// Every script gets the session id as $1, never spliced in. Files live in a
// private folder (never a shared /tmp, where another user could plant a
// symlink or resume the session).
const DIR = '"$HOME/.claude/freeze"'
const FILE = `${DIR}/"$1.thaw"`
const STOPPED = `${DIR}/"$1.stopped"`
const STATE_FILE = `${DIR}/"$1.state"`
const FREEZE_SH = `umask 077 && mkdir -p ${DIR} && rm -f ${FILE} && [ ! -e ${FILE} ]`
const THAW_SH = `umask 077 && mkdir -p ${DIR} && touch ${FILE}`
const WAIT_SH = `until [ -e ${FILE} ]; do sleep 1; done`

// Background tasks are the processes whose stdout is one of this session's
// task output files (…/<session-id>/tasks/<id>.output). Claude Code starts each
// in a session of its own (setsid), and every child inherits it, even one in a
// process group of its own or logging elsewhere: the session is what gets
// paused. MCP servers share Claude's session, which is never touched, and a
// session is only paused when its leader is itself a task process. Linux only
// (/proc); elsewhere nothing is paused. Run once the freeze has settled, when
// no foreground command is left.
const PAUSE_SH = `[ -d /proc/self/fd ] || { echo unsupported; exit 0; }
umask 077 && mkdir -p ${DIR}
echo "# owner $PPID $(ps -o lstart= -p $PPID | tr -s ' ' '_')" > ${STOPPED}
own=$(ps -o sid= -p $$ | tr -d ' ')
pids=$(for fd in /proc/[0-9]*/fd/1; do
  case "$(readlink "$fd" 2>/dev/null)" in
    */"$1"/tasks/*) p=\${fd#/proc/}; echo "\${p%%/*}" ;;
  esac
done)
leaders=" $(echo $pids) "
for pid in $pids; do ps -o sid= -p "$pid"; done | tr -d ' ' | sort -u | while read -r sid; do
  case "$sid" in ''|*[!0-9]*|0|1) continue ;; esac
  [ "$sid" = "$own" ] && continue
  case "$leaders" in *" $sid "*) ;; *) continue ;; esac
  pkill -STOP -s "$sid" && echo "$sid" >> ${STOPPED}
done
grep -c '^[0-9]' ${STOPPED} || true`
const RESUME_SH = `[ -f ${STOPPED} ] || exit 0
while read -r sid; do
  case "$sid" in ''|*[!0-9]*|0|1) continue ;; esac
  pkill -CONT -s "$sid"
done < ${STOPPED}
rm -f ${STOPPED}`
// A record whose owner (the Claude process that paused, by pid and start
// time, so a reused pid does not count) is gone was left by a crash or a kill:
// its tasks would stay stopped forever. Continue them and drop the record.
// Thaw files older than a week are pruned. Prints how many sessions resumed.
const RECOVER_SH = `n=0
for f in ${DIR}/*.stopped; do
  [ -e "$f" ] || continue
  read -r _ _ pid start < "$f"
  if [ -n "$pid" ] && [ "$(ps -o lstart= -p "$pid" 2>/dev/null | tr -s ' ' '_')" = "$start" ]; then
    continue
  fi
  while read -r sid; do
    case "$sid" in ''|*[!0-9]*|0|1) continue ;; esac
    pkill -CONT -s "$sid" && n=$((n + 1))
  done < "$f"
  rm -f "$f"
done
find ${DIR} -name '*.thaw' -mtime +7 -delete 2>/dev/null
find ${DIR} -name '*.state' -mtime +30 -exec grep -qx running {} \\; -delete 2>/dev/null
find ${DIR} -name '.state.*' -mmin +60 -delete 2>/dev/null
echo "$n"`
const CLEAN_SH = `${RESUME_SH}
rm -f ${FILE}`
// The session's phase ($2, one of three fixed words) for tools outside the
// session. Written to a temporary file in the private folder,
// then renamed over the state file, so a reader never sees half a word.
const WRITE_STATE_SH = `case "$2" in running|freezing|frozen) ;; *) exit 2 ;; esac
umask 077 && mkdir -p ${DIR} && chmod 700 ${DIR}
tmp=$(mktemp ${DIR}/.state.XXXXXX) || exit 1
if printf '%s\\n' "$2" > "$tmp" && mv -f "$tmp" ${STATE_FILE}; then exit 0; fi
rm -f "$tmp"
exit 1`
const REMOVE_STATE_SH = `rm -f ${STATE_FILE}`
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

// Tools that only host other loops: their inner steps and tool calls are
// counted themselves, so counting the host would never let a freeze settle.
const CONTAINER_TOOLS = new Set(['Agent', 'Task', 'Workflow'])

// After a resume, an MCP call failing like this most likely hit a connection
// that dropped while frozen (network change, expired session).
const MCP_WATCH_MS = 10 * 60_000
const CONNECTION_ERROR =
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|not connected|disconnected|connection (closed|lost|refused|reset)|session (expired|not found)|\b401\b|unauthori[sz]ed|re-?auth/i

const IDLE: FreezeState = {
  isFrozen: false,
  since: null,
  parked: 0,
  running: 0,
  paused: 0,
  resumedAt: null,
}
const state = atom({ plugin: 'freeze', key: 'state' } as const, IDLE)

// Prompts the session starts by itself (a /loop or routine firing, a task
// notification) that arrived while frozen: an identical one is held once.
const SELF_STARTED = new Set(['scheduled-trigger', 'task-notification'])
let heldPrompts = new Set<string>()

// Set from the options at each (re)load.
let shouldPauseBackground = true
let toggleHint = '/freeze'
let hasBand = false
// Whether the main thread's turn is running, i.e. its spinner is on screen.
let isWorking = false

const hhmm = (ms: number | null) =>
  ms === null ? '' : new Date(ms).toTimeString().slice(0, 5)

const isSettled = (s: FreezeState) => s.isFrozen && s.running === 0

// What ~/.claude/freeze/<session-id>.state says: `freezing` while in-flight
// work settles, `frozen` once it is safe to disconnect, `running` otherwise.
type Phase = 'running' | 'freezing' | 'frozen'

const phaseOf = (s: FreezeState): Phase =>
  !s.isFrozen ? 'running' : isSettled(s) ? 'frozen' : 'freezing'

// One full line at a time: the spinner while a turn runs, else the band when
// the shortcut is on, else the status line.
function statusText(s: FreezeState) {
  if (!s.isFrozen || isWorking || hasBand) {
    return undefined
  }

  return stateLine(s)
}

async function refreshStatus($: EngineInterface) {
  $.ui.status(statusText(await read($, state)))
}

function stateLine(s: FreezeState) {
  return isSettled(s)
    ? frozenLine(s)
    : `❄ Freezing · ${s.running} still running · ${toggleHint} to cancel`
}

// "❄ Frozen since 17:49 · safe to disconnect · 2 background paused · /freeze to resume"
function frozenLine(s: FreezeState) {
  const paused = s.paused > 0 ? ` · ${s.paused} background paused` : ''

  return `❄ Frozen since ${hhmm(s.since)} · safe to disconnect${paused} · ${toggleHint} to resume`
}

function queue() {
  let tail: Promise<unknown> = Promise.resolve()

  return <T,>(work: () => Promise<T>) => {
    const run = tail.then(work)
    tail = run.catch(() => undefined)

    return run
  }
}

// Pausing, resuming and toggling run one at a time, so a late pause can never
// stop processes after a resume, and quick presses cannot interleave.
const serial = queue()
// State file writes too, apart: a toggle waits on them, never the reverse.
const serialStateFile = queue()

// The phase last sent to the state file, written or not. Undefined after a
// (re)load or a session end, so the next change writes it; a failed write is
// retried when the phase changes again, not on every tool call.
let sentPhase: Phase | undefined
let hasWarnedStateFile = false
// The session that ended: work still settling as it closes must not write its
// state file again once removed.
let endedSessionId: string | undefined

// Writes the current phase, read when the write runs, so writes that queue up
// end on the latest one. Never rejects: the file is for outside readers, and
// must not fail a freeze, a resume or a tool call. A failure is shown once.
function syncStateFile($: EngineInterface) {
  return serialStateFile(async () => {
    try {
      const id = await $.session.id()
      if (id === endedSessionId) {
        return
      }
      endedSessionId = undefined
      // Read again after each write, for a change that landed during it.
      for (;;) {
        const phase = phaseOf(await read($, state))
        if (phase === sentPhase) {
          return
        }
        sentPhase = phase
        await shFor($, id, WRITE_STATE_SH, [phase])
        hasWarnedStateFile = false
      }
    } catch (error) {
      if (!hasWarnedStateFile) {
        hasWarnedStateFile = true
        $.ui.toast(`could not write the freeze state file (${reasonOf(error)})`)
      }
    }
  })
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function change($: EngineInterface, fn: (s: FreezeState) => FreezeState) {
  let before = IDLE
  // State kept from an older version of the mod may lack newer fields.
  const next = await update($, state, s => {
    before = { ...IDLE, ...s }

    return fn(before)
  })
  $.ui.status(statusText(next))
  if (phaseOf(next) !== sentPhase) {
    await syncStateFile($)
  }
  if (shouldPauseBackground && !isSettled(before) && isSettled(next)) {
    void serial(() => pauseBackground($))
  }

  return next
}

function checkSessionId(id: string) {
  if (!SESSION_ID.test(id)) {
    throw new Error(`unexpected session id ${JSON.stringify(id)}`)
  }

  return id
}

async function sessionId($: EngineInterface) {
  return checkSessionId(await $.session.id())
}

// Runs a fixed script with this session's id as $1 and `args` after it.
async function sh($: EngineInterface, script: string, args: string[] = []) {
  return shFor($, await $.session.id(), script, args)
}

async function shFor($: EngineInterface, id: string, script: string, args: string[] = []) {
  const { exitCode, stdout, stderr } = await $.process.run([
    'sh',
    '-c',
    script,
    'sh',
    checkSessionId(id),
    ...args,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `exit ${exitCode}`)
  }

  return stdout.trim()
}

async function pauseBackground($: EngineInterface) {
  if (!isSettled(await read($, state))) {
    return
  }
  try {
    const out = await sh($, PAUSE_SH)
    if (out === 'unsupported') {
      $.ui.toast('pausing background tasks needs Linux (/proc); they keep running')

      return
    }
    const paused = Number(out) || 0
    await change($, s => ({ ...s, paused }))
  } catch (error) {
    $.ui.toast(`could not pause background tasks (${error instanceof Error ? error.message : String(error)})`)
  }
}

async function freeze($: EngineInterface) {
  // File first, then the flag: a waiter never sees "frozen" + thaw file.
  await sh($, FREEZE_SH)
  const since = await $.clock.now()
  heldPrompts = new Set()
  await change($, s => ({ ...s, isFrozen: true, since }))
}

async function thaw($: EngineInterface) {
  // Background tasks first, then the waiters. If the thaw file cannot be
  // written, the session stays honestly frozen.
  await sh($, RESUME_SH)
  await sh($, THAW_SH)
  const resumedAt = await $.clock.now()
  await change($, s => ({ ...s, isFrozen: false, since: null, paused: 0, resumedAt }))
}

// `/freeze shortcut on`: binds ctrl+x f in ~/.claude/keybindings.json (merged,
// never overwriting another binding or a file that is not valid JSON) and
// turns the option on, which reloads the mod with its band. `off` turns the
// option off and leaves the binding (inert without the band).
async function setShortcut($: EngineInterface, isOn: boolean) {
  if (isOn) {
    const problem = await bindShortcutKey($)
    if (problem) {
      return problem
    }
  }
  const result = await $.config.set({ key: `${$.plugin.name}.shortcut`, value: isOn })
  if ('deny' in result && result.deny) {
    return `could not change the shortcut option (${result.deny}). Set it in /config.`
  }

  return isOn
    ? `Shortcut on: ${KEY_LABEL} toggles freeze (bound in ~/.claude/keybindings.json).`
    : `Shortcut off. The ${KEY_LABEL} binding stays in ~/.claude/keybindings.json, inert without the band.`
}

async function bindShortcutKey($: EngineInterface) {
  const home = (await $.process.run(['sh', '-c', 'printf %s "$HOME"'])).stdout
  const path = `${home}/.claude/keybindings.json`
  const exists = (await $.process.run(['test', '-e', path])).exitCode === 0
  let doc: { bindings?: unknown } = {}
  if (exists) {
    try {
      doc = JSON.parse(await $.fs.read(path))
    } catch {
      return `${path} is not valid JSON, left untouched. Add the binding by hand (README).`
    }
  }
  const blocks = Array.isArray(doc.bindings) ? (doc.bindings as KeyBlock[]) : []
  const chat = blocks.find(b => b?.context === 'Chat')
  const current = chat?.bindings?.[KEY_LABEL]
  if (current === KEY_ACTION) {
    return undefined
  }
  if (current) {
    return `${KEY_LABEL} is already bound to ${current} in ${path}, left untouched.`
  }
  const nextChat: KeyBlock = {
    context: 'Chat',
    bindings: { ...(chat?.bindings ?? {}), [KEY_LABEL]: KEY_ACTION },
  }
  const nextDoc = {
    $schema: 'https://www.schemastore.org/claude-code-keybindings.json',
    $docs: 'https://code.claude.com/docs/en/keybindings',
    ...doc,
    bindings: chat ? blocks.map(b => (b === chat ? nextChat : b)) : [...blocks, nextChat],
  }
  await $.fs.write(path, `${JSON.stringify(nextDoc, null, 2)}\n`)

  return undefined
}

type KeyBlock = { context?: string; bindings?: Record<string, string | null> }

type Outcome =
  | { kind: 'froze' | 'resumed' | 'already-frozen' | 'not-frozen' }
  | { kind: 'failed'; action: 'freeze' | 'resume'; reason: string }

// `/freeze on` and `off` are idempotent: asking for the state the session is
// already in (settling included) changes nothing. `undefined` toggles. The
// state is read inside the queue, so quick requests see each other's result.
function setFrozen($: EngineInterface, shouldFreeze?: boolean) {
  return serial(async (): Promise<Outcome> => {
    const { isFrozen } = await read($, state)
    const target = shouldFreeze ?? !isFrozen
    if (target === isFrozen) {
      return { kind: isFrozen ? 'already-frozen' : 'not-frozen' }
    }
    try {
      await (target ? freeze($) : thaw($))

      return { kind: target ? 'froze' : 'resumed' }
    } catch (error) {
      return { kind: 'failed', action: target ? 'freeze' : 'resume', reason: reasonOf(error) }
    }
  })
}

async function pressToggle($: EngineInterface) {
  const outcome = await setFrozen($)
  if (outcome.kind === 'failed') {
    $.ui.toast(`could not ${outcome.action} (${outcome.reason})`)
  }
}

async function outcomeText($: EngineInterface, outcome: Outcome) {
  switch (outcome.kind) {
    case 'froze':
      return '❄ Freezing. Running work finishes, then everything parks. /freeze or /freeze off to resume.'
    case 'resumed':
      return 'Resumed.'
    case 'not-frozen':
      return 'Not frozen.'
    case 'already-frozen': {
      const s = await read($, state)

      return isSettled(s)
        ? 'Already frozen · safe to disconnect.'
        : `Already freezing · ${s.running} still running.`
    }
    case 'failed':
      return `Could not ${outcome.action} (${outcome.reason}).`
  }
}

// Waits until resumed. The child is tied to the dispatch: Esc (`signal`)
// kills it at once. A child that fails (cannot start, exits non-zero) is not
// a resume: the mod fails open and clears the state, so the UI never claims
// FROZEN while the session runs.
async function park($: EngineInterface, signal: AbortSignal) {
  await change($, s => ({ ...s, parked: s.parked + 1 }))
  try {
    const wait = $.process.spawn({ argv: ['sh', '-c', WAIT_SH, 'sh', await sessionId($)] })
    const pieces = wait[Symbol.asyncIterator]()
    let piece = await pieces.next()
    while (!piece.done && !signal.aborted) {
      piece = await pieces.next()
    }
    if (signal.aborted || (piece.done && piece.value?.code === 0)) {
      return
    }
    throw new Error(`wait ended with ${JSON.stringify(piece.value)}`)
  } catch (error) {
    if (!signal.aborted) {
      await serial(() => sh($, RESUME_SH)).catch(() => undefined)
      await change($, s => ({ ...s, isFrozen: false, since: null, paused: 0 }))
      $.ui.toast(`could not hold the session, resumed (${error instanceof Error ? error.message : String(error)})`)
    }
  } finally {
    await change($, s => ({ ...s, parked: Math.max(0, s.parked - 1) }))
  }
}

const running = (delta: number) => (s: FreezeState) => ({
  ...s,
  running: Math.max(0, s.running + delta),
})

// The gate in front of every step and tool call. It counts the work first and
// checks the flag second, so a freeze landing in between shows "1 still
// running" rather than "safe to disconnect". Resolves false when the dispatch
// was abandoned (Esc) while parked: the caller must not run anything then.
async function gate($: EngineInterface, signal: AbortSignal) {
  await change($, running(1))
  if (!(await read($, state)).isFrozen) {
    return true
  }

  await change($, running(-1))
  await park($, signal)
  if (signal.aborted) {
    return false
  }
  await change($, running(1))

  return true
}

// Names the MCP server whose call failed on a dropped connection, once per
// server, for a while after a resume.
const warnedServers = new Set<string>()

async function checkMcpCall($: EngineInterface, tool: string, outcome: unknown) {
  const { resumedAt } = await read($, state)
  if (resumedAt === null || (await $.clock.now()) - resumedAt > MCP_WATCH_MS) {
    return
  }
  const failure =
    outcome instanceof Error
      ? outcome.message
      : (outcome as { isError?: boolean }).isError
        ? JSON.stringify(outcome)
        : ''
  const server = tool.split('__')[1] ?? tool
  if (!CONNECTION_ERROR.test(failure) || warnedServers.has(server)) {
    return
  }
  warnedServers.add(server)
  $.ui.toast(`MCP server "${server}" lost its connection while frozen, run /mcp to reconnect`)
}

export const register: Register = (on, options) => {
  const hasShortcut = options.shortcut === true
  shouldPauseBackground = options.pauseBackground !== false
  toggleHint = hasShortcut ? `/freeze or ${KEY_LABEL}` : '/freeze'
  hasBand = hasShortcut
  isWorking = false

  on('turn.start', async ($, e, next) => {
    isWorking = true
    await refreshStatus($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isWorking = false
      await refreshStatus($)
    }

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'freeze',
      description: 'Freeze or resume this session at the next safe boundary',
      argumentHint: '[on|off] · shortcut on|off',
      immediate: true,
    })
    // Fires again on every reload: counters from a previous load are stale,
    // and nothing may stay stopped unless the session is frozen.
    const s = await change($, prev => ({ ...prev, parked: 0, running: 0 }))
    if (!s.isFrozen) {
      await serial(() => sh($, RESUME_SH)).catch(() => undefined)
    }
    const recovered = Number(await sh($, RECOVER_SH).catch(() => '0')) || 0
    if (recovered > 0) {
      $.ui.toast(`resumed ${recovered} background task(s) left paused by a session that ended`)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // Never leave background tasks stopped behind a closed session. The ending
    // session's id is the event's: after a /clear the process goes on under
    // another, whose state file is written on its next change.
    await shFor($, e.sessionId, CLEAN_SH).catch(() => undefined)
    await serialStateFile(async () => {
      endedSessionId = e.sessionId
      sentPhase = undefined
      await shFor($, e.sessionId, REMOVE_STATE_SH).catch(() => undefined)
    })

    return next(e)
  })

  on('command.run', { command: 'freeze' }, async ($, e) => {
    const args = e.args.trim().toLowerCase().split(/\s+/).join(' ')
    if (args === 'shortcut on' || args === 'shortcut off') {
      return { text: await setShortcut($, args === 'shortcut on') }
    }
    if (args !== '' && args !== 'on' && args !== 'off') {
      return { text: 'Usage: /freeze (toggle) · /freeze on|off · /freeze shortcut on|off' }
    }
    const shouldFreeze = args === '' ? undefined : args === 'on'

    return { text: await outcomeText($, await setFrozen($, shouldFreeze)) }
  })

  on('prompt.submit', async ($, e, next) => {
    if (SELF_STARTED.has(e.origin.kind) && (await read($, state)).isFrozen) {
      const key = `${e.origin.kind}:${e.text}`
      if (heldPrompts.has(key)) {
        return { drop: 'the same prompt is already held until you resume' }
      }
      heldPrompts = new Set([...heldPrompts, key])
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (CONTAINER_TOOLS.has(e.tool)) {
      // Not counted (its inner loop is gated step by step), only held.
      if ((await read($, state)).isFrozen) {
        await park($, next.signal)
      }

      return next.signal.aborted
        ? { deny: 'Interrupted while the session was frozen.' }
        : next(e)
    }

    if (!(await gate($, next.signal))) {
      // Interrupted while parked: never run a tool of an abandoned turn.
      return { deny: 'Interrupted while the session was frozen.' }
    }
    try {
      const outcome = await next(e)
      if (e.tool.startsWith('mcp__')) {
        await checkMcpCall($, e.tool, outcome)
      }

      return outcome
    } catch (error) {
      if (e.tool.startsWith('mcp__')) {
        await checkMcpCall($, e.tool, error)
      }
      throw error
    } finally {
      await change($, running(-1))
    }
  })

  on('turn.step', async function* ($, e, next) {
    if (!(await gate($, next.signal))) {
      // Interrupted while parked: answer for the step with "no request was
      // made", so nothing is sent for an abandoned turn (a bare return is
      // refused by the engine, which then skips the hook).
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    }
    try {
      return yield* next(e)
    } finally {
      await change($, running(-1))
    }
  })

  // The line that animates while a turn runs (`Swooping… (3m 1s …)`). While
  // work is still in flight it keeps animating, honestly, as "Freezing…"; once
  // settled it is replaced whole, timer included, by a static frozen line.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const s = await read($, state)
    if (!s.isFrozen) {
      return next(e)
    }
    if (!isSettled(s)) {
      const message = `Freezing · ${s.running} still running · ${toggleHint} to cancel`

      return next({ ...e, props: { ...e.props, message, suffix: '' } })
    }

    const { Text } = $.ui.resolve(e)

    return <Text color="cyan">{frozenLine(s)}</Text>
  })

  if (!hasShortcut) {
    return
  }

  // The band exists only for the shortcut: its Button is what the borrowed
  // keybinding action presses. Without the option, the status line suffices.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const s = await read($, state)
    const { Box, Button } = $.ui.resolve(e)
    // While a turn runs, the spinner carries the state: the band is only the
    // button. Idle, the band is the one full line.
    const action = isSettled(s) ? 'resume' : 'cancel'
    const label = !s.isFrozen
      ? `❄ ${KEY_LABEL} freeze`
      : e.props.isWorking
        ? `❄ ${KEY_LABEL} ${action}`
        : stateLine(s)

    return (
      <Box>
        <Button
          key="toggle"
          plain
          dimColor={!s.isFrozen}
          action={KEY_ACTION}
          label={label}
          onPress={() => void pressToggle($)}
        />
      </Box>
    )
  })
}
