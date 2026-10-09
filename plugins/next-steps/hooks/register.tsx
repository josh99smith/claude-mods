import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, List } from '../types'

// One to-do list per project (keyed by the session's directory), kept in the
// plugin's store so it outlives the session; the on/off switch is global. The
// session's copy lives in $.state so the panel redraws whenever it changes.

const TOOL = 'mcp__next-steps__update'
const PANE = 'next-steps'
const SKIP = /(^|\s)#notodo\b/i
const FORCE = /(^|\s)#todo\b/i
const EMPTY: List = { next: 1, items: [] }

const listAtom = atom({ plugin: 'next-steps', key: 'list' } as const, EMPTY)
const onAtom = atom({ plugin: 'next-steps', key: 'isOn' } as const, true)
const showDoneAtom = atom({ plugin: 'next-steps', key: 'showDone' } as const, false)
const categoryAtom = atom({ plugin: 'next-steps', key: 'category' } as const, 'General')
/** Claude's own tasks this session (TaskCreate), id → title, so a TaskUpdate that finishes one can be matched. */
const tasksAtom = atom({ plugin: 'next-steps', key: 'tasks' } as const, {} as Record<string, string>)

const listKey = (cwd: string) => `list:${cwd}`
const BOARD_FILE = '.claude/next-steps.json'

/**
 * The project's board, a claude.ai artifact page that holds the list where the
 * Claude app can show it, named in .claude/next-steps.json ({ "board": url }) so
 * every session of the project (a fresh cloud container too) finds it. With a
 * board the list lives there and Claude keeps it through ArtifactData; this
 * plugin's own store is the list only where there is none.
 */
async function boardUrl($: EngineInterface): Promise<string | undefined> {
  try {
    const raw = await $.fs.read(`${await $.session.cwd()}/${BOARD_FILE}`)
    const url = (JSON.parse(String(raw)) as { board?: unknown }).board
    return typeof url === 'string' && url.startsWith('https://claude.ai/') ? url : undefined
  } catch {
    return undefined
  }
}

function boardInstruction(url: string): string {
  return [
    'The next-steps tracker is on for this prompt. The to-do list lives on a board page,',
    `${url}, in its database collection \`items\` (doc id = the item's id as a string; fields`,
    'id (number), category, text, done (boolean), at (ISO time)). When you have finished the request:',
    '1. Read the board: ArtifactData list on `items` (load ArtifactData with ToolSearch if needed).',
    '   Items the user ticked there are done; never reopen them.',
    '   As you finish an open item, even mid-turn, update it {done: true} on the board right away.',
    '2. Suggest the next steps: end your reply with a short "Suggested next steps" section, one',
    '   line each, grouped under a short category (reuse the board\'s categories where they fit: e.g.',
    '   Bugs, Features, Tests, Docs, Refactor, Ops, Questions). Concrete steps the user or a later',
    '   session could take, not restatements of what was done. Skip steps already open on the board.',
    '3. One ArtifactData batch: `set` each suggestion as a new doc (ids continue from the highest),',
    '   and `update` {done: true} (with its if_version) on any open item this work finished.',
    '   Say nothing about these calls; the board updates by itself.',
    'If nothing remains and nothing was finished, skip 2 and 3.',
  ].join('\n')
}

async function fromStore($: EngineInterface): Promise<List> {
  const raw = (await $.store.get(listKey(await $.session.cwd()))) as List | undefined
  return raw && Array.isArray(raw.items) ? raw : EMPTY
}

async function isOn($: EngineInterface): Promise<boolean> {
  return (await $.store.get('enabled')) !== false
}

async function showStatus($: EngineInterface, list: List, on: boolean): Promise<void> {
  const open = list.items.filter(i => !i.done).length
  $.ui.status(`todo: ${on ? 'on' : 'off'} · ${open} open`)
}

/** Changes the list (a copy), then writes the store, the panel's state and the status line. */
async function edit($: EngineInterface, change: (list: List) => void): Promise<List> {
  const list = JSON.parse(JSON.stringify(await fromStore($))) as List
  change(list)
  // Keep the store small: finished items beyond the newest 200 are dropped.
  const done = list.items.filter(i => i.done)
  if (done.length > 200) {
    const drop = new Set(done.slice(0, done.length - 200).map(i => i.id))
    list.items = list.items.filter(i => !drop.has(i.id))
  }
  await $.store.set(listKey(await $.session.cwd()), list)
  await update($, listAtom, () => list)
  await showStatus($, list, await isOn($))
  return list
}

async function setOn($: EngineInterface, on: boolean): Promise<void> {
  await $.store.set('enabled', on)
  await update($, onAtom, () => on)
  await showStatus($, await fromStore($), on)
}

function addItem(list: List, category: string, text: string, at: string): number | undefined {
  const clean = text.trim()
  if (!clean) return undefined
  if (list.items.some(i => !i.done && i.text.toLowerCase() === clean.toLowerCase())) return undefined
  list.items.push({ id: list.next, category: category.trim() || 'General', text: clean, done: false, at })
  return list.next++
}

/** "Bugs: fix it" → category and text; plain text takes the fallback category. */
function parseEntry(entry: string, fallback: string): { category: string; text: string } {
  const m = /^([^:]{1,40}):\s*(.+)$/.exec(entry.trim())
  return m ? { category: m[1]?.trim() ?? fallback, text: m[2]?.trim() ?? '' } : { category: fallback, text: entry.trim() }
}

function grouped(items: Item[]): [string, Item[]][] {
  const groups = new Map<string, Item[]>()
  for (const item of items) groups.set(item.category, [...(groups.get(item.category) ?? []), item])
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
}

/** The list grouped by category, as Markdown. */
export function render(list: List, withDone = false): string {
  const shown = list.items.filter(i => withDone || !i.done)
  if (shown.length === 0) return 'No next steps recorded for this project.'
  const out: string[] = []
  for (const [category, items] of grouped(shown)) {
    out.push(`**${category}**`)
    for (const i of items) out.push(`- [${i.done ? 'x' : ' '}] #${i.id} ${i.text}`)
    out.push('')
  }
  return out.join('\n').trim()
}

function instruction(list: List): string {
  const open = list.items.filter(i => !i.done)
  const current = open.length
    ? open.slice(-60).map(i => `#${i.id} [${i.category}] ${i.text}`).join('\n')
    : '(empty)'
  return [
    'The next-steps tracker is on for this prompt. When you have finished the request:',
    '1. Suggest the next steps: end your reply with a short "Suggested next steps" section, one',
    '   line each, grouped under a short category (reuse an existing one where it fits: e.g. Bugs,',
    '   Features, Tests, Docs, Refactor, Ops, Questions). Concrete steps the user or a later session',
    '   could take, not restatements of what was done. Skip steps already open below.',
    `2. Call ${TOOL} once with exactly those suggestions as \`add\`, and the ids of any open item`,
    '   this work finished as `done`. Say nothing about the call itself.',
    'If nothing remains and nothing was finished, skip both.',
    'Open items now:',
    current,
  ].join('\n')
}

const words = (s: string) =>
  s.toLowerCase().replace(/#\d+/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * The open item a task of Claude's stands for: one whose "#id" its title names,
 * else one with the same words, or whose words hold the other's whole (the
 * shorter at least three words, so "fix it" never ticks "fix the kickoff camera").
 */
export function matchItem(list: List, title: string): Item | undefined {
  const open = list.items.filter(i => !i.done)
  for (const m of title.matchAll(/#(\d+)\b/g)) {
    const hit = open.find(i => i.id === Number(m[1]))
    if (hit) return hit
  }
  const t = words(title)
  if (!t) return undefined
  const exact = open.find(i => words(i.text) === t)
  if (exact) return exact
  return open.find(i => {
    const w = words(i.text)
    const [short, long] = w.length < t.length ? [w, t] : [t, w]
    return short.split(' ').length >= 3 && ` ${long} `.includes(` ${short} `)
  })
}

/**
 * Ticks the open items that tasks Claude just completed stand for. Without a
 * board that is the list itself; with one, the board is Claude's to write, so
 * Claude is told which finished task to tick there.
 */
async function tickFor($: EngineInterface, titles: string[]): Promise<string | undefined> {
  if (titles.length === 0) return undefined
  const board = await boardUrl($)
  if (board) {
    const names = titles.map(t => `"${t}"`).join(', ')
    return `next-steps: if ${names} is an open item on the to-do board (${board}), mark it done there now (ArtifactData update {done: true}).`
  }
  const list = await fromStore($)
  const ids = titles.map(t => matchItem(list, t)?.id).filter((n): n is number => n !== undefined)
  if (ids.length === 0) return undefined
  await edit($, l => {
    for (const i of l.items) if (ids.includes(i.id)) i.done = true
  })
  return undefined
}

const now = async ($: EngineInterface) => new Date(await $.clock.now()).toISOString()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'update',
      description:
        "Updates the project's next-steps to-do list: add new items, each with a category, and mark finished ones done by id.",
      inputSchema: {
        type: 'object',
        properties: {
          add: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                category: { type: 'string', description: 'A short category, e.g. Bugs, Features, Tests, Docs' },
                text: { type: 'string', description: 'One concrete next step' },
              },
              required: ['category', 'text'],
            },
          },
          done: { type: 'array', items: { type: 'integer' }, description: 'Ids of items now finished' },
        },
      },
    })
    await $.command.register({
      name: 'todo',
      description: 'Next-steps panel; or list | all | on | off | done <id> | undo <id> | add <Category>: <text> | clear',
      argumentHint: '[list|all|on|off|done <id>|undo <id>|add <Category>: <text>|clear [all]]',
      immediate: true,
    })
    const list = await fromStore($)
    const enabled = await isOn($)
    await update($, listAtom, () => list)
    await update($, onAtom, () => enabled)
    await showStatus($, list, enabled)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Plugins' own prompts and slash commands are left alone.
    if (e.origin?.kind === 'plugin' || e.text.trimStart().startsWith('/')) return next(e)
    const skip = SKIP.test(e.text)
    const force = FORCE.test(e.text)
    const text = e.text.replace(SKIP, ' ').replace(FORCE, ' ').trim() || e.text
    const track = !skip && (force || (await isOn($)))
    if (!track) return next({ ...e, text })
    const board = await boardUrl($)
    const note = board ? boardInstruction(board) : instruction(await fromStore($))
    return next({ ...e, text, context: [...(e.context ?? []), note] })
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { add?: { category?: string; text?: string }[]; done?: number[] }
    const added: number[] = []
    const finished: number[] = []
    const at = await now($)
    await edit($, list => {
      for (const id of input.done ?? []) {
        const item = list.items.find(i => i.id === id)
        if (item && !item.done) {
          item.done = true
          finished.push(id)
        }
      }
      for (const a of input.add ?? []) {
        const id = addItem(list, a.category ?? '', a.text ?? '', at)
        if (id !== undefined) added.push(id)
      }
    })
    const ids = (ns: number[]) => (ns.length ? ns.map(n => `#${n}`).join(', ') : 'nothing')
    return { result: `Added ${ids(added)}; marked done ${ids(finished)}.` }
  })

  // Claude's own task list: completing a task (TaskUpdate, or a todo in
  // TodoWrite) ticks the open item it stands for, so the checklist follows the work.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const task = ran.deny === undefined && !ran.isError ? (ran.result as { task?: { id?: string } } | undefined)?.task : undefined
    if (task?.id) await update($, tasksAtom, t => ({ ...t, [task.id as string]: e.subject }))
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const tasks = await read($, tasksAtom)
    const title = e.subject ?? tasks[e.taskId]
    if (e.subject) await update($, tasksAtom, t => ({ ...t, [e.taskId]: e.subject as string }))
    if (e.status !== 'completed' || !title) return ran
    const note = await tickFor($, [title])
    return note ? { ...ran, context: [...(ran.context ?? []), note] } : ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const was = new Set(
      ((ran.result as { oldTodos?: { content: string; status: string }[] } | undefined)?.oldTodos ?? [])
        .filter(t => t.status === 'completed')
        .map(t => t.content),
    )
    const titles = e.todos.filter(t => t.status === 'completed' && !was.has(t.content)).map(t => t.content)
    const note = await tickFor($, titles)
    return note ? { ...ran, context: [...(ran.context ?? []), note] } : ran
  })

  on('command.run', { command: 'todo' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = e.args.trim().slice(verb.length).trim()
    const board = await boardUrl($)
    if (board && !['on', 'off'].includes(verb.toLowerCase())) {
      const state = (await isOn($)) ? 'on' : 'off'
      return { text: `Your to-do list is on its board: ${board}\n\nOpen it to tick, add or remove steps. Tracking is ${state} (/todo on, /todo off).` }
    }
    switch (verb.toLowerCase()) {
      case '': {
        // A cloud session followed from the Claude app has no screen of its own
        // that draws a mod's panel (no surface attached, or only a phone's), yet
        // the open still reports placed: print the list there instead.
        const surfaces = await $.session.surfaces()
        const canDraw = surfaces.some(s => s === 'terminal' || s === 'desktop' || s === 'vscode')
        const opened = canDraw ? await $.ui.open({ id: PANE, title: 'Next steps' }) : undefined
        if (opened?.isPlaced) return { text: `Next-steps panel opened (${surfaces.join(', ')}).` }
        const where = canDraw
          ? 'The panel needs a wider window.'
          : 'This screen does not draw panels (it works in Claude Code in a terminal, the desktop app or VS Code).'
        return { text: `${render(await fromStore($))}\n\n_${where} /todo done <id>, add <Category>: <text>, on, off._` }
      }
      case 'on':
      case 'off':
        await setOn($, verb.toLowerCase() === 'on')
        return { text: `Next-steps tracking is ${verb.toLowerCase()}. (#todo or #notodo in a prompt overrides it for that prompt.)` }
      case 'done':
      case 'undo': {
        const ids = rest.map(s => Number(s.replace('#', ''))).filter(Number.isFinite)
        const isDone = verb.toLowerCase() === 'done'
        let hit: number[] = []
        await edit($, list => {
          const items = list.items.filter(i => ids.includes(i.id))
          for (const i of items) i.done = isDone
          hit = items.map(i => i.id)
        })
        return { text: hit.length ? `${isDone ? 'Done' : 'Reopened'}: ${hit.map(n => `#${n}`).join(', ')}` : 'No item with that id.' }
      }
      case 'add': {
        const { category, text } = parseEntry(arg, 'General')
        if (!text) return { text: 'Usage: /todo add <Category>: <text>' }
        const at = await now($)
        let id: number | undefined
        await edit($, list => {
          id = addItem(list, category, text, at)
        })
        return { text: id === undefined ? 'That step is already open.' : `Added #${id} to ${category}.` }
      }
      case 'clear': {
        const all = arg.toLowerCase() === 'all'
        await edit($, list => {
          list.items = all ? [] : list.items.filter(i => !i.done)
        })
        return { text: all ? 'Cleared every item.' : 'Cleared finished items.' }
      }
      case 'all':
        return { text: render(await fromStore($), true) }
      default: {
        const state = (await isOn($)) ? 'on' : 'off'
        return { text: `${render(await fromStore($))}\n\n_Tracking is ${state}: /todo on, /todo off._` }
      }
    }
  })

  // The panel: the list by category, each step a checkbox to tick and an x to
  // remove, a field to add one, and the tracking switch. Every control writes
  // through edit(), so the panel, the store and the status line stay together.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, listAtom)
    const tracking = await read($, onAtom)
    const showDone = await read($, showDoneAtom)
    const category = await read($, categoryAtom)
    const open = list.items.filter(i => !i.done)
    const doneCount = list.items.length - open.length
    const shown = list.items.filter(i => showDone || !i.done)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 60
    const textWidth = Math.max(12, width - 12)
    const clip = (s: string) => (s.length > textWidth * 3 ? `${s.slice(0, textWidth * 3 - 1)}…` : s)
    const categories = [...new Set(['General', ...list.items.map(i => i.category)])].sort()

    const toggle = (item: Item) => () =>
      edit($, l => {
        const it = l.items.find(i => i.id === item.id)
        if (it) it.done = !it.done
      })
    const remove = (item: Item) => () =>
      edit($, l => {
        l.items = l.items.filter(i => i.id !== item.id)
      })
    const add = async (value: string) => {
      const { category: c, text } = parseEntry(value, category)
      const at = await now($)
      await edit($, l => void addItem(l, c, text, at))
      await update($, categoryAtom, () => c)
    }

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>
          {open.length} open{doneCount ? `  ·  ${doneCount} done` : ''}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button
            key="tracking"
            hotkey="t"
            variant={tracking ? 'primary' : 'secondary'}
            label={tracking ? 'Tracking on' : 'Tracking off'}
            onPress={() => setOn($, !tracking)}
          />
        </Box>
      </Box>
    )

    const rows =
      shown.length === 0 ? (
        <Text dimColor>
          {list.items.length === 0
            ? 'Nothing yet. Steps Claude suggests after each prompt land here.'
            : 'Everything is done.'}
        </Text>
      ) : (
        <Box flexDirection="column">
          {grouped(shown).map(([name, items]) => (
            <Box key={`cat-${name}`} flexDirection="column" marginTop={1}>
              <Text bold color="cyan">
                {name} <Text dimColor>({items.filter(i => !i.done).length})</Text>
              </Text>
              {items.map(item => (
                <Box key={`row-${item.id}`} flexDirection="row" gap={1}>
                  <Button key={`done-${item.id}`} plain label={item.done ? '☑' : '☐'} onPress={toggle(item)} />
                  <Box flexGrow={1}>
                    <Text dimColor={item.done} strikethrough={item.done} wrap="wrap">
                      {clip(item.text)}
                    </Text>
                  </Box>
                  <Text dimColor>#{item.id}</Text>
                  <Button key={`del-${item.id}`} plain dimColor label="✕" onPress={remove(item)} />
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      )

    const footer = (
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button
          key="show-done"
          hotkey="d"
          label={showDone ? 'Hide done' : 'Show done'}
          onPress={() => update($, showDoneAtom, v => !v)}
        />
        {doneCount > 0 && (
          <Button key="clear" hotkey="c" label="Clear done" onPress={() => edit($, l => void (l.items = l.items.filter(i => !i.done)))} />
        )}
      </Box>
    )

    if (e.surface === 'mobile') {
      return (
        <Box flexDirection="column">
          {header}
          {rows}
          {footer}
        </Box>
      )
    }

    const { Input, Select } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {header}
        {rows}
        <Box flexDirection="column" marginTop={1}>
          <Select
            key="category"
            label="Category "
            value={category}
            options={categories.map(c => ({ value: c, label: c }))}
            onSelect={v => update($, categoryAtom, () => v)}
          />
          <Input
            key="new"
            label="+ "
            placeholder={`Add a step to ${category} (or "Bugs: fix it")`}
            value=""
            submitLabel="add"
            onSubmit={value => void add(value)}
          />
        </Box>
        {footer}
      </Box>
    )
  })
}
