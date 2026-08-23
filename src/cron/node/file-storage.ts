import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { CronStorage } from '../storage.js'
import type { CronTask, CronTaskChanges } from '../types.js'
import { atomicWriteJson } from './json-utils.js'

/**
 * Filesystem CronStorage: `<cronDir>/tasks.json`, atomic tmp+rename
 * replacement, all mutations serialized through an in-process promise
 * chain (single-writer per issue #42).
 */
export class FileCronStorage implements CronStorage {
  private readonly filePath: string
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(cronDir: string) {
    this.filePath = path.join(cronDir, 'tasks.json')
  }

  async load(): Promise<CronTask[]> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new Error(`Cron task file corrupted (invalid JSON): ${this.filePath}`, { cause: err })
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Cron task file corrupted (expected array): ${this.filePath}`)
    }
    return parsed as CronTask[]
  }

  async get(taskId: string): Promise<CronTask | null> {
    return (await this.load()).find((t) => t.id === taskId) ?? null
  }

  add(task: Omit<CronTask, 'id' | 'createdAt'>): Promise<CronTask> {
    return this.serialize(async () => {
      const tasks = await this.load()
      const full: CronTask = { ...task, id: randomUUID(), createdAt: Date.now() }
      tasks.push(full)
      await atomicWriteJson(this.filePath, tasks)
      return full
    })
  }

  update(taskId: string, changes: CronTaskChanges): Promise<CronTask | null> {
    return this.serialize(async () => {
      const tasks = await this.load()
      const target = tasks.find((t) => t.id === taskId)
      if (!target) return null
      Object.assign(target, changes)
      await atomicWriteJson(this.filePath, tasks)
      return { ...target }
    })
  }

  remove(ids: string[]): Promise<void> {
    return this.serialize(async () => {
      const tasks = await this.load()
      await atomicWriteJson(this.filePath, tasks.filter((t) => !ids.includes(t.id)))
    })
  }

  markFired(ids: string[], firedAt: number): Promise<void> {
    return this.serialize(async () => {
      const tasks = await this.load()
      for (const t of tasks) {
        if (ids.includes(t.id)) t.lastFiredAt = firedAt
      }
      await atomicWriteJson(this.filePath, tasks)
    })
  }

  /** Serialize mutations: read-inside-chain makes load+write atomic per op. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn)
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
