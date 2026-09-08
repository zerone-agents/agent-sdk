import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDefaultMemoryService, defaultMemoryDataDir } from './default.js'

let dataDir: string
beforeEach(async () => { dataDir = await mkdtemp(path.join(tmpdir(), 'mem-default-')) })
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }) })

describe('createDefaultMemoryService', () => {
  it('stores under <dataDir>/memory and creates nothing before start()', async () => {
    expect(await readdir(dataDir)).toEqual([]) // SDK never creates dirs implicitly
    const service = createDefaultMemoryService({ dataDir })
    expect(await readdir(dataDir)).toEqual([])
    await service.start()
    const memoryDir = path.join(dataDir, 'memory')
    // start() acquires the lock only; state.json appears at the first
    // checkpoint (close() or the checkpointEvery-th commit — Task 13 semantics)
    expect((await readdir(memoryDir)).sort()).toEqual(['runtime.lock'])
    const session = await service.bind({ actor: 'session' })
    await session.add({ scope: 'global', content: 'persisted', importance: 50 })
    expect((await readdir(memoryDir)).sort()).toEqual(['journal.jsonl', 'runtime.lock'])
    await service.stop()
    // stop() checkpoints (state.json), compacts the journal and releases the
    // lock (runtime.lock unlinked)
    expect((await readdir(memoryDir)).sort()).toEqual(['journal.jsonl', 'state.json'])
  })

  it('open while already started fails on a second lock holder', async () => {
    const other = createDefaultMemoryService({ dataDir })
    await other.start()
    const second = createDefaultMemoryService({ dataDir })
    await expect(second.start()).rejects.toThrow(/locked|already running/i)
    await other.stop()
  })

  it('data survives restart through the same dataDir', async () => {
    const first = createDefaultMemoryService({ dataDir })
    await first.start()
    const session = await first.bind({ actor: 'session' })
    const { record } = await session.add({ scope: 'global', content: 'durable', importance: 75 })
    await first.stop()

    const second = createDefaultMemoryService({ dataDir })
    await second.start()
    const hits = await (await second.bind({ actor: 'session' })).search({ text: 'durable' })
    expect(hits[0]!.id).toBe(record!.id)
    await second.stop()
  })

  it('defaultMemoryDataDir points at ~/.agents', () => {
    expect(defaultMemoryDataDir()).toBe(path.join(process.env.HOME ?? '', '.agents'))
  })
})