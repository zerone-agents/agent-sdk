import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Atomic JSON write: serialize to a sibling .tmp file, then rename over the
 * target. A crash mid-write leaves the old snapshot intact (issue #42:
 * "写入失败不破坏旧快照" — guaranteed structurally, not by error simulation).
 */
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, filePath)
}
