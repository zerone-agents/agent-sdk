import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Redirect homedir() for this file so the default path never touches the
// real ~/.agents during tests.
const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => state.home }
})

import { createDefaultCronService, defaultCronDataDir } from './default.js'

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'cron-default-path-'))
  state.home = scratch
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('default cron data dir', () => {
  it('defaultCronDataDir() resolves to <homedir>/.agents', () => {
    expect(defaultCronDataDir()).toBe(path.join(scratch, '.agents'))
  })

  it('createDefaultCronService without dataDir persists under <homedir>/.agents/cron', async () => {
    const service = createDefaultCronService({
      resolveAgent: async () => {
        throw new Error('no agent needed here')
      },
    })
    await service.start()

    const task = await service.create({ cron: '* * * * *', prompt: 'p' })
    const cronDir = path.join(scratch, '.agents', 'cron')
    expect((await readdir(cronDir)).sort()).toEqual([
      'execution-index.json',
      'runtime.lock',
      'tasks.json',
    ])
    expect((await service.get(task.id))?.id).toBe(task.id)

    await service.stop()
    expect((await readdir(cronDir)).includes('runtime.lock')).toBe(false)
  })

  it('explicit dataDir still wins over the default', async () => {
    const custom = path.join(scratch, 'custom-root')
    const service = createDefaultCronService({
      dataDir: custom,
      resolveAgent: async () => {
        throw new Error('no agent needed here')
      },
    })
    await service.start()
    await service.create({ cron: '* * * * *', prompt: 'p' })

    expect((await readdir(path.join(custom, 'cron'))).includes('tasks.json')).toBe(true)

    await service.stop()
  })
})
