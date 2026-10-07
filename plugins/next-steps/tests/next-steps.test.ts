import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

// The engine stamps origin, presentation and wait on a real run; a test leaves them out.
const todo = ($: Engine, args: string) => $.command.run({ command: 'todo', args } as never)
const say = ($: Engine, text: string) => $.prompt.submit({ text } as never)

test('the list keeps added steps by category and marks them done', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 0 })
  on('session.cwd', () => ({ value: '/proj' }))
  await todo($, 'add Bugs: fix the kickoff camera')
  await todo($, 'add Docs: write the README')
  let shown = (await todo($, 'list')).text ?? ''
  expect(shown).toContain('**Bugs**')
  expect(shown).toContain('#1 fix the kickoff camera')
  await todo($, 'done 1')
  shown = (await todo($, 'list')).text ?? ''
  expect(shown).not.toContain('kickoff camera')
  expect(shown).toContain('write the README')
})

test('a prompt gets the tracker note when on, not when off or #notodo', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 0 })
  on('session.cwd', () => ({ value: '/proj' }))
  const seen: (readonly string[] | undefined)[] = []
  const texts: string[] = []
  on('prompt.submit', ($, e) => {
    seen.push(e.context)
    texts.push(e.text)
    return { text: e.text, context: e.context }
  })
  await say($, 'fix the bug')
  await say($, 'fix the bug #notodo')
  await todo($, 'off')
  await say($, 'just a question')
  await say($, 'this one #todo')
  expect(seen.length).toBe(4)
  expect(seen[0]?.join('')).toContain('Suggested next steps')
  expect(seen[1]).toBeUndefined()
  expect(texts[1]).toBe('fix the bug')
  expect(seen[2]).toBeUndefined()
  expect(seen[3]?.join('')).toContain('Suggested next steps')
})

test("Claude's update call adds steps, skips duplicates and marks done", async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 0 })
  on('session.cwd', () => ({ value: '/proj' }))
  const call = (input: Record<string, unknown>) =>
    $.tool.call({ tool: 'mcp__next-steps__update', ...input } as never)
  await call({ add: [{ category: 'Tests', text: 'Cover the punt' }, { category: 'Bugs', text: 'Fix the clock' }] })
  await call({ add: [{ category: 'Tests', text: 'cover the punt' }], done: [2] })
  const shown = (await todo($, 'all')).text ?? ''
  expect(shown).toContain('- [ ] #1 Cover the punt')
  expect(shown).toContain('- [x] #2 Fix the clock')
  expect(shown).not.toContain('#3')
})

const PANE = {
  component: 'Pane',
  requestId: 'next-steps',
  props: { title: 'Next steps', isFocused: true, bodyColumns: 60, placement: 'dock' } as never,
} as const

test('the panel ticks, removes and adds steps by click', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 0 })
  on('session.cwd', () => ({ value: '/proj' }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('session.surfaces', () => ({ value: ['terminal'] }) as never)
  await todo($, 'add Bugs: fix the kickoff camera')
  await todo($, 'add Docs: write the README')
  for (const surface of ['terminal', 'desktop'] as const) {
    await todo($, 'clear all')
    await todo($, 'add Bugs: fix the kickoff camera')
    await todo($, 'add Docs: write the README')
    const ui = await $.ui.mount({ plugin: 'next-steps', surface, ...PANE })
    const ids = ((await todo($, 'all')).text ?? '').match(/#(\d+)/g) ?? []
    const [first, second] = ids.map(s => s.slice(1))
    expect(await ui.find({ type: 'Text', text: /2 open/ })).toBeDefined()
    await ui.press({ key: `done-${first}` })
    expect(await ui.find({ type: 'Text', text: /1 open/ })).toBeDefined()
    expect(await ui.find({ key: `done-${first}` })).toBeUndefined()
    await ui.press({ key: 'show-done' })
    expect(await ui.find({ key: `done-${first}` })).toBeDefined()
    await ui.press({ key: `del-${second}` })
    expect(await ui.find({ type: 'Text', text: /0 open/ })).toBeDefined()
    await ui.input({ key: 'new', text: 'Tests: cover the punt' })
    expect(await ui.find({ type: 'Text', text: /cover the punt/ })).toBeDefined()
    expect((await todo($, '')).text).toContain('panel')
    await ui.press({ key: 'tracking' })
    expect((await todo($, 'list')).text).toContain('Tracking is off')
    await ui.press({ key: 'tracking' })
    await ui.press({ key: 'show-done' })
    await ui.unmount()
  }
})

test('the panel draws on a phone, without the add field', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 0 })
  on('session.cwd', () => ({ value: '/proj' }))
  await todo($, 'add Bugs: fix the kickoff camera')
  const ui = await $.ui.mount({ plugin: 'next-steps', surface: 'mobile', ...PANE })
  expect(await ui.find({ type: 'Text', text: /1 open/ })).toBeDefined()
  expect(await ui.find({ key: 'new' })).toBeUndefined()
  await ui.unmount()
})

test('with no screen that draws panels, /todo prints the list', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 0 })
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.surfaces', () => ({ value: [] }) as never)
  await todo($, 'add Bugs: fix the kickoff camera')
  const shown = (await todo($, '')).text ?? ''
  expect(shown).toContain('fix the kickoff camera')
  expect(shown).toContain('does not draw panels')
})

test('with a board named in the project, prompts point at the board and /todo links it', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 0 })
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.read', () => ({ value: JSON.stringify({ board: 'https://claude.ai/artifact/abc' }) }) as never)
  const seen: string[] = []
  on('prompt.submit', ($, e) => {
    seen.push((e.context ?? []).join(''))
    return { text: e.text, context: e.context }
  })
  await say($, 'fix the bug')
  expect(seen[0]).toContain('https://claude.ai/artifact/abc')
  expect(seen[0]).toContain('ArtifactData')
  expect((await todo($, '')).text).toContain('https://claude.ai/artifact/abc')
  expect((await todo($, 'off')).text).toContain('tracking is off')
})
