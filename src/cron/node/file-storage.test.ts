import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileCronStorage } from './file-storage.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cron-sdk-storage-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('FileCronStorage', () => {
  it('returns an empty list when tasks.json does not exist', async () => {
    const storage = new FileCronStorage(dir)
    expect(await storage.load()).toEqual([])
  })

  it('add() generates id/createdAt and persists atomically', async () => {
    const storage = new FileCronStorage(dir)
    const task = await storage.add({ cron: '* * * * *', prompt: 'p' })

    expect(task.id).toBeTruthy()
    expect(typeof task.createdAt).toBe('number')
    const onDisk = JSON.parse(await readFile(path.join(dir, 'tasks.json'), 'utf8'))
    expect(onDisk).toEqual([task])
    expect(await storage.get(task.id)).toEqual(task)
  })

  it('get() returns null for a missing task', async () => {
    const storage = new FileCronStorage(dir)
    expect(await storage.get('nope')).toBeNull()
  })

  it('update() applies partial changes and returns null when missing', async () => {
    const storage = new FileCronStorage(dir)
    const task = await storage.add({ cron: '* * * * *', prompt: 'p' })

    const updated = await storage.update(task.id, { name: 'report', cron: '0 9 * * 1-5' })
    expect(updated).toMatchObject({ id: task.id, name: 'report', cron: '0 9 * * 1-5' })
    expect(await storage.update('nope', { name: 'x' })).toBeNull()
    expect((await storage.load())[0]).toMatchObject({ name: 'report' })
  })

  it('remove() deletes tasks by id', async () => {
    const storage = new FileCronStorage(dir)
    const a = await storage.add({ cron: '* * * * *', prompt: 'a' })
    const b = await storage.add({ cron: '* * * * *', prompt: 'b' })
    await storage.remove([a.id])

    const rest = await storage.load()
    expect(rest.map((t) => t.id)).toEqual([b.id])
  })

  it('markFired() stamps lastFiredAt', async () => {
    const storage = new FileCronStorage(dir)
    const task = await storage.add({ cron: '* * * * *', prompt: 'p' })

    await storage.markFired([task.id], 123)

    expect((await storage.load())[0]!.lastFiredAt).toBe(123)
  })

  it('serializes concurrent mutations (no lost update)', async () => {
    const storage = new FileCronStorage(dir)
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => storage.add({ cron: '* * * * *', prompt: `p${i}` })),
    )

    expect((await storage.load())).toHaveLength(10)
  })

  it('re-reads state from disk with a new instance (restart)', async () => {
    const a = new FileCronStorage(dir)
    const task = await a.add({ cron: '* * * * *', prompt: 'p' })

    const b = new FileCronStorage(dir)
    expect(await b.load()).toEqual([task])
  })

  it('refuses to start when tasks.json is corrupt', async () => {
    await writeFile(path.join(dir, 'tasks.json'), '{not json', 'utf8')
    const storage = new FileCronStorage(dir)

    await expect(storage.load()).rejects.toThrow(/tasks\.json/)
  })
})
