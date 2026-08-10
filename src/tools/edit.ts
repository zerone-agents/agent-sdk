/**
 * FileEditTool - Precise string replacement in files with fuzzy matching
 */

import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { diffLines, createTwoFilesPatch } from 'diff'
import { defineTool } from './types.js'
import { replace } from './edit-replacers.js'

// ---------------------------------------------------------------------------
// Line ending detection and conversion
// ---------------------------------------------------------------------------

function detectLineEnding(content: string): '\n' | '\r\n' {
  const crlfCount = (content.match(/\r\n/g) || []).length
  const lfCount = (content.match(/(?<!\r)\n/g) || []).length
  return crlfCount > lfCount ? '\r\n' : '\n'
}

function convertLineEndings(text: string, ending: '\n' | '\r\n'): string {
  return text.replace(/\r?\n/g, ending)
}

// ---------------------------------------------------------------------------
// Diff generation using the 'diff' package
// ---------------------------------------------------------------------------

function generateDiffAndStats(
  oldContent: string,
  newContent: string,
  filePath: string,
): { diff: string; additions: number; deletions: number } {
  const changes = diffLines(oldContent, newContent)
  const additions = changes
    .filter((c) => c.added)
    .reduce((sum, c) => sum + c.count, 0)
  const deletions = changes
    .filter((c) => c.removed)
    .reduce((sum, c) => sum + c.count, 0)
  const diff = createTwoFilesPatch(filePath, filePath, oldContent, newContent, '', '', {
    context: 3,
  })
  return { diff, additions, deletions }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const FileEditTool = defineTool({
  name: 'Edit',
  description: [
    'Performs exact string replacements in files.',
    '',
    'Before editing, you MUST read the file first with the Read tool to understand the exact content.',
    '',
    'The edit will FAIL if old_string is not found in the file. Make sure to copy the text from your',
    'Read tool output exactly, excluding the line number prefix.',
    '',
    'The edit will FAIL if old_string is found multiple times. Provide more surrounding context to',
    'make it unique, or set replace_all to true to change every occurrence.',
    '',
    'Keep each old_string / new_string under 1000 characters. For edits larger than that, prefer',
    'splitting into multiple smaller Edits or rewriting the whole file with the Write tool.',
    '',
    'Set old_string to empty string to create a new file.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to modify',
      },
      old_string: {
        type: 'string',
        description: 'The text to find and replace. Copy it exactly from the file content (without line number prefixes). Use empty string to create a new file.',
      },
      new_string: {
        type: 'string',
        description: 'The replacement text. Must be different from old_string.',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences of old_string in the file. Useful for renaming a variable or updating repeated strings.',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, context) {
    const filePath = resolve(context.cwd, input.file_path)
    const { old_string, new_string, replace_all } = input

    if (old_string === new_string) {
      return { data: 'Error: new_string must be different from old_string', is_error: true }
    }

    try {
      // Special case: empty old_string → create/overwrite new file
      if (old_string === '') {
        const content = convertLineEndings(new_string, '\n')
        await writeFile(filePath, content, 'utf-8')
        const { diff, additions, deletions } = generateDiffAndStats('', content, filePath)
        return {
          data: `File created: ${filePath}`,
          metadata: { filePath, diff, additions, deletions },
        }
      }

      // Read existing file
      const oldContent = await readFile(filePath, 'utf-8')
      const lineEnding = detectLineEnding(oldContent)

      // Normalize line endings to match file
      const normalizedOld = convertLineEndings(old_string, lineEnding)
      const normalizedNew = convertLineEndings(new_string, lineEnding)

      // Run the fuzzy replacement chain
      const result = replace(oldContent, normalizedOld, normalizedNew, replace_all || false)
      if ('error' in result) {
        if (result.notFound) {
          return { data: `Could not find old_string in the file. It must match exactly, including whitespace, indentation, and line endings. Please read the file again and copy the exact text.`, is_error: true }
        }
        return { data: `Found multiple matches for old_string. Provide more surrounding context in old_string to make it unique, or set replace_all to true to replace every occurrence.`, is_error: true }
      }

      const newContent = result.content

      // Write the file
      await writeFile(filePath, newContent, 'utf-8')

      // Generate diff and stats
      const { diff, additions, deletions } = generateDiffAndStats(oldContent, newContent, filePath)

      return {
        data: 'Edit applied successfully.',
        metadata: { filePath, diff, additions, deletions },
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { data: `File not found: ${filePath}. Please verify the file path is correct.`, is_error: true }
      }
      return { data: `Error editing file: ${err.message}`, is_error: true }
    }
  },
})
