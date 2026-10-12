<p align="center">
  <img src="assets/logo.svg" alt="Claude Freeze logo" width="112">
</p>

<h1 align="center">Claude Freeze</h1>

<p align="center">A Claude Code mod that <strong>freezes a session and resumes it later as if nothing happened</strong>.</p>

Stepping away in the middle of a task (a commute, a meeting, a laptop that has to
sleep) leaves poor options today. `Esc` or `Ctrl+C` cancels the step in progress,
and you then have to tell Claude it was only a pause. `Ctrl+Z` suspends the whole
process wherever it happens to be, so a reply that is still streaming can fail once
the network drops. Checkpoint and handoff skills carry on in a fresh session,
without the live context.

`/freeze` keeps the session as it is. Whatever is already running finishes, then
the session (subagents included) parks before its next step, and it tells you once
nothing is talking to the network anymore, so you can close the lid or switch wifi.
Run `/freeze` again and the turn continues exactly where it stopped, with nothing
added to the conversation. `/freeze on` and `/freeze off` do the same explicitly,
for scripts and tools that drive sessions.

The state shows on one line at a time: the spinner while a turn runs, otherwise the
status line (or the band, with the optional shortcut):

```
✻ Freezing · 1 still running · /freeze to cancel (3m 1s)          ← finishing in-flight work
❄ Frozen since 08:12 · safe to disconnect · /freeze to resume     ← parked: animation and timer stop
```

## What it does

- **Freezes at a safe boundary.** A model reply that is streaming or a tool that is
  running finishes first; nothing is killed or retried.
- **Freezes everything.** The main thread, subagents and background agents all park
  at their next model request or tool call.
- **Stops the spinner.** Once parked, the animated line and its timer give way to a
  static `❄ Frozen since …` line, so the session no longer looks busy.
- **Holds self-started turns.** `/loop` wakeups, background-task notifications and
  messages you type while frozen wait until you resume; a wakeup that fires again
  with the same prompt is held only once.
- **Tells you when it is safe.** The band and the status line say `freezing…` while
  work is still in flight and `safe to disconnect` once nothing is talking to the
  network: from then on you can close the lid, switch wifi, or go offline.
- **Pauses background tasks too** (Linux). Commands started in the background,
  monitors and dev servers are paused once the freeze settles and continue when you
  resume, so nothing fails or keeps working behind your back while you are offline.
- **Names the MCP servers that dropped.** If an MCP call fails on a lost connection
  shortly after you resume, a toast tells you which server to reconnect with `/mcp`.
- **Per session.** Each Claude Code session freezes on its own.
- **Readable from outside.** Each session's state (`running`, `freezing` or
  `frozen`) is kept in a one-word file, so a tool that drives several sessions can
  show it.

## Install

Requires Claude Code with mods (function-hook plugins, on by default since 2.1.287;
built and tested on 2.1.289) and a POSIX `sh` (macOS or Linux).

### Option A: as a plugin (recommended)

The repo is its own marketplace:

```sh
claude plugin marketplace add francktrouillez/claude-freeze
claude plugin install freeze@claude-freeze
```

Then start a new session, or run `/reload-plugins` in a running one. `/freeze` works
right away; the shortcut is optional (below).

Update later with:

```sh
claude plugin marketplace update claude-freeze
claude plugin update freeze@claude-freeze
```

### Option B: from a clone (for hacking on it)

```sh
git clone https://github.com/francktrouillez/claude-freeze.git ~/Projects/claude-freeze
```

Then load it in every session by naming the folder in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/Projects/claude-freeze"
  }
}
```

(or once, with `claude --plugin-dir ~/Projects/claude-freeze`). An interactive
session watches the folder: saving a file reloads the mod.

### Options

Set in `/config`, under the `freeze` plugin (the mod reloads by itself). For a clone
loaded with `CLAUDE_CODE_PLUGIN_DIRS`, the same live in `~/.claude/settings.json`
under `"pluginConfigs": { "freeze": { "options": { … } } }`.

| Option | Default | What it does |
| --- | --- | --- |
| `pauseBackground` | on | Pause this session's background tasks while frozen (Linux). |
| `shortcut` | off | Show the band above the prompt with the `Ctrl+X F` button. |

### Optional: the `Ctrl+X F` shortcut

Off by default. Turning it on adds a one-line band above the prompt that carries the
button the shortcut presses. While a turn runs, the spinner already shows the state,
so the band is only the button; when idle, the band takes over from the status line:

```
❄ ctrl+x f freeze                                                       ← not frozen
❄ ctrl+x f resume                                                       ← frozen, turn running (spinner has the rest)
❄ Frozen since 08:12 · safe to disconnect · /freeze or ctrl+x f to resume  ← frozen, idle
```

Turn it on with **`/freeze shortcut on`**: it adds the `ctrl+x f` binding to
`~/.claude/keybindings.json` (merged with what is there; it never takes over a key
bound to something else, nor touches a file that is not valid JSON) and turns the
`shortcut` option on. `/freeze shortcut off` turns the option off again.

To do it by hand instead: set the `shortcut` option (above) and add the binding
below. Mods cannot register keyboard shortcuts of their own. The band's button borrows an
engine action instead, `app:cycleDiffBase` (normally only live inside the diff
panel), and a chord bound to that action at the prompt presses the button. Add it to
`~/.claude/keybindings.json` (create the file if it does not exist; merge if it does):

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "$docs": "https://code.claude.com/docs/en/keybindings",
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "ctrl+x f": "app:cycleDiffBase"
      }
    }
  ]
}
```

Why not `Ctrl+F`: the prompt already uses it to move the cursor forward, so the key
never reaches the band. `ctrl+x …` is Claude Code's own prefix for extra shortcuts
and is free at the prompt.

## Usage

| Action | How |
| --- | --- |
| Freeze / resume | `/freeze` (toggle); with the shortcut on, also `Ctrl+X F` or a click on the band |
| Freeze / resume, explicitly | `/freeze on` / `/freeze off`: nothing happens when the session already is, so a script can send them safely |
| Turn the shortcut on / off | `/freeze shortcut on` / `/freeze shortcut off` |
| Know it is safe to disconnect | wait for `safe to disconnect` |
| Cancel a freeze that is still settling | `/freeze` or `/freeze off` (`/freeze on` keeps it) |
| Abandon the parked turn | `Esc`: the parked step is dropped, never run later |

`/freeze` works mid-turn (it is an *immediate* command), including where the shortcut
cannot reach: the transcript view (`Ctrl+O`), an open dialog, the desktop app, or a
session followed from another device.

## How it works

- **The gate.** Hooks on `turn.step` (before every model request, subagents included)
  and `tool.call` (before every tool starts) check the frozen flag. When it is set,
  the hook waits before letting the step through, so the request is sent only after
  you resume, unchanged.
- **The hold.** A mod hook has a 10 s budget of its *own* time, but time spent in a
  `$` call does not count. A parked hook therefore waits on `$.process.spawn` of a
  tiny `sh` loop that exits once `~/.claude/freeze/<session-id>.thaw` exists.
  Freezing removes that file and resuming creates it. The child is tied to the turn:
  `Esc` kills it at once, and the parked step is then refused, never run later.
- **Failing open, honestly.** If the wait cannot run or exits with an error, the mod
  resumes the session rather than hang it, clears the frozen state (so nothing
  claims `FROZEN` while work runs) and shows a toast.
- **The in-flight counter.** Each model request and tool call is counted *before*
  the gate checks the flag, and for as long as it runs. Tools that only host other loops (`Agent`, `Task`,
  `Workflow`) are not counted, since their inner steps are. `freezing…` turns into
  `safe to disconnect` when the count reaches zero.
- **Background tasks.** Once the freeze settles (nothing in flight), the mod finds
  the processes whose output goes to this session's task files. Claude Code starts
  each background task in a session of its own, so the mod pauses that whole session
  (`pkill -STOP -s`), children included, and records it. On resume it continues
  exactly those (`pkill -CONT -s`) before the turn goes on. Anything still recorded
  is also continued when the mod reloads unfrozen and when the session ends. Each
  record names the Claude process that paused (pid and start time): if that process
  is gone (a crash, a kill), the next session that starts continues the tasks and
  drops the record, so nothing stays stopped forever.
- **Repeated wakeups.** While frozen, a self-started prompt (a `/loop` or routine
  firing, a task notification) identical to one already held is dropped. Prompts
  you type are never touched.
- **Dropped MCP connections.** For ten minutes after a resume, an MCP tool call
  that fails with a connection-type error (reset, timeout, not connected, 401)
  raises one toast per server: `MCP server "x" lost its connection while frozen,
  run /mcp to reconnect`.
- **The state file.** `~/.claude/freeze/<session-id>.state` holds one word and a
  newline: `running`, `freezing` (in-flight work still settling) or `frozen` (safe to
  disconnect). It is rewritten only when that word changes, through a temporary file
  renamed over it, so a reader never sees half a word. It is removed when the session
  ends. No file means `running`. A session that crashes can leave its file behind, so
  it only means something for a session that is still alive (leftover `running` files
  are pruned after 30 days). If the file cannot be written, a toast says so once and
  the freeze itself goes on.
- **One line at a time.** The spinner carries the state while a turn runs; when
  idle, the band does (shortcut on) or else the status line.
- **The band** (shortcut option only). A one-line band above the prompt carries the
  button the shortcut presses.

## Security

- The mod has no network access and reads nothing from your conversation.
- It never changes a tool call or a model request. It only delays them, and drops
  a step you interrupt with `Esc` while frozen.
- It runs a few fixed shell commands on your machine, and only signals the
  background tasks of the session it runs in. The session id and the state word are
  passed to them as arguments, never spliced into the command, and both are checked
  against a fixed pattern first.
- Its files live in `~/.claude/freeze/`, kept private (`0700`, files `0600`), never
  in a shared `/tmp`. The state file says only `running`, `freezing` or `frozen`:
  nothing from the conversation.

Found a vulnerability? Please report it privately through the repository's
**Security** tab (**Report a vulnerability**) rather than in a public issue.

## Known limitations

- **The `[-]` at the right of the band** (shortcut option only) is drawn by Claude
  Code on every band above the prompt (it collapses the band, also
  `ctrl+x ctrl+a`). A mod cannot hide it. Collapsing the band also unmounts the
  button, so the shortcut stops working until you expand it again; `/freeze` still
  works. Leave the option off for no band at all.
- **The band sits above the prompt.** Below the prompt, a mod can only append text
  to the hint line (where the permission mode shows) or replace that whole line,
  losing Claude Code's own live indicators. The shortcut needs a button, and the
  band is the place for it.
- **Paused is not reconnected.** Pausing stops background tasks from working and
  failing while you are offline, but a connection a task held open can still be
  reset by a network change; it sees that when it continues (many tools retry).
- **Background pausing is Linux-only** (it reads `/proc`). On macOS the tasks keep
  running while frozen, and a toast says so.
- **A paused dev server does not answer** until you resume. Turn `pauseBackground`
  off if you want it to keep serving while frozen.
- **MCP connections are not reconnected by the mod**, which can only reach its own
  servers. Claude Code reconnects remote servers (sometimes asking to
  re-authenticate); the mod's toast tells you which one to look at.
- **Subagents are assumed to share the session id** (they read the same thaw file).
  Verified for the main thread; for subagents it follows from the API, not a test.
- **The turn's clock still counts the frozen time.** The mod hides the timer while
  frozen, but the elapsed time shown after you resume (and the closing
  `… for 12m 3s` line) includes the time spent frozen.
- **The prompt cache expires after about an hour.** Resuming after a long freeze
  re-reads the whole conversation once, at full input price.

## Development

```sh
claude plugin validate .   # what the module hooks and calls, and anything the engine would refuse
claude plugin test .       # tests/*.test.ts against the engine's test kit
tsc -p .                   # type-check (once the mod has loaded, which lays .claude-plugin/types/)
```

Files:

```
.claude-plugin/plugin.json       manifest
.claude-plugin/marketplace.json  makes the repo installable as a marketplace
hooks/hooks.json                 names the hooks module
hooks/register.tsx               the mod
types/index.d.ts                 the mod's state contract ($.state)
tests/freeze.test.ts             park, resume, toggle, on/off, state file, fail-open, background, MCP, spinner, band and shortcut-setup tests
```

## Contributing

Contributions are welcome: bug reports, ideas and pull requests.

- **Issues:** say what you did, what you expected and what happened, with your
  Claude Code version (`claude --version`) and OS.
- **Pull requests:** keep them focused, add a test for new behaviour, and make sure
  `claude plugin validate .` and `claude plugin test .` pass. Mods run on an
  early-access API, so mention the Claude Code version you tested with.
- **Not sure about an idea?** Open an issue first to talk it through.

## License

[MIT](LICENSE)
