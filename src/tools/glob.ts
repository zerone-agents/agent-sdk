/**
 * GlobTool - File pattern matching
 *
 * Uses fs.promises.glob (Node 22+).
 */

import { glob } from 'fs/promises'
import { resolve } from 'path'
import { defineTool } from './types.js'

export const GlobTool = defineTool({
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns matching file paths sorted by modification time. Supports patterns like "**/*.ts", "src/**/*.js".',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The glob pattern to match files against',
      },
      path: {
        type: 'string',
        description: 'The directory to search in (defaults to cwd)',
      },
    },
    required: ['pattern'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const searchDir = input.path ? resolve(context.cwd, input.path) : context.cwd
    const { pattern } = input

    try {
      const matches: string[] = []
      for await (const entry of glob(pattern, { cwd: searchDir })) {
        if (context.abortSignal?.aborted) break
        matches.push(entry)
        if (matches.length >= 500) break
      }
      if (matches.length === 0) {
        return `No files matching pattern "${pattern}" in ${searchDir}`
      }
      return matches.join('\n')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Error searching for files with pattern "${pattern}": ${message}`
    }
  },
})
