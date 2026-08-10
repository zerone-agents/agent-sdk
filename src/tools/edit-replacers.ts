/**
 * Edit Replacers - 5-level fuzzy matching chain for string replacement.
 *
 * Tries each replacer in order from most precise to most lenient.
 * First unique match wins.
 */

export interface ReplaceResult {
  content: string
}

export interface ReplaceError {
  error: string
  notFound: boolean
}

interface Replacer {
  name: string
  find(content: string, oldString: string, replaceAll: boolean): { match: string; index: number; count: number } | null
}

function findAllOccurrences(content: string, search: string): { index: number; match: string }[] {
  const matches: { index: number; match: string }[] = []
  let pos = 0
  while (true) {
    const idx = content.indexOf(search, pos)
    if (idx === -1) break
    matches.push({ index: idx, match: search })
    pos = idx + search.length
  }
  return matches
}

// Replacer 1: Exact match
const exactReplacer: Replacer = {
  name: 'exact',
  find(content, oldString) {
    const matches = findAllOccurrences(content, oldString)
    if (matches.length === 0) return null
    return { match: oldString, index: matches[0].index, count: matches.length }
  },
}

// Replacer 2: Line-level trim
const lineTrimReplacer: Replacer = {
  name: 'line-trim',
  find(content, oldString) {
    const contentLines = content.split('\n')
    const oldLines = oldString.split('\n')
    const oldTrimmed = oldLines.map((l) => l.trim())

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      let match = true
      for (let j = 0; j < oldLines.length; j++) {
        if (contentLines[i + j].trim() !== oldTrimmed[j]) {
          match = false
          break
        }
      }
      if (match) {
        const actualMatch = contentLines.slice(i, i + oldLines.length).join('\n')
        const allMatches = findAllOccurrences(content, actualMatch)
        return { match: actualMatch, index: allMatches[0].index, count: allMatches.length }
      }
    }
    return null
  },
}

// Replacer 3: Indentation normalization
function minIndent(lines: string[]): number {
  let min = Infinity
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const leading = line.match(/^[\t ]*/)?.[0].length ?? 0
    if (leading < min) min = leading
  }
  return min === Infinity ? 0 : min
}

const indentNormalizeReplacer: Replacer = {
  name: 'indent-normalize',
  find(content, oldString) {
    const oldLines = oldString.split('\n')
    const oldMinIndent = minIndent(oldLines)
    const normalizedOld = oldLines.map((l) => l.slice(oldMinIndent)).join('\n')

    const contentLines = content.split('\n')

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const candidateLines = contentLines.slice(i, i + oldLines.length)
      const candidateMinIndent = minIndent(candidateLines)
      const normalizedCandidate = candidateLines.map((l) => l.slice(candidateMinIndent)).join('\n')
      if (normalizedCandidate === normalizedOld) {
        const actualMatch = candidateLines.join('\n')
        const allMatches = findAllOccurrences(content, actualMatch)
        return { match: actualMatch, index: allMatches[0].index, count: allMatches.length }
      }
    }
    return null
  },
}

// Replacer 4: Whitespace folding (collapse runs of spaces/tabs to a single space)
function foldWhitespace(s: string): string {
  return s.replace(/[ \t]+/g, ' ')
}

const whitespaceFoldReplacer: Replacer = {
  name: 'whitespace-fold',
  find(content, oldString) {
    const oldLines = foldWhitespace(oldString).split('\n')
    const contentLines = content.split('\n')

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const candidateLines = contentLines.slice(i, i + oldLines.length)
      const foldedCandidate = candidateLines.map(foldWhitespace)
      let match = true
      for (let j = 0; j < oldLines.length; j++) {
        if (foldedCandidate[j] !== oldLines[j]) {
          match = false
          break
        }
      }
      if (match) {
        const actualMatch = candidateLines.join('\n')
        const allMatches = findAllOccurrences(content, actualMatch)
        return { match: actualMatch, index: allMatches[0].index, count: allMatches.length }
      }
    }
    return null
  },
}

// Replacer 5: Escape sequence normalization
function unescapeString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\')
}

const escapeNormalizeReplacer: Replacer = {
  name: 'escape-normalize',
  find(content, oldString) {
    const unescaped = unescapeString(oldString)
    if (unescaped === oldString) return null
    const matches = findAllOccurrences(content, unescaped)
    if (matches.length === 0) return null
    return { match: unescaped, index: matches[0].index, count: matches.length }
  },
}

// Replacer 6: Whole-string trim
const wholeTrimReplacer: Replacer = {
  name: 'whole-trim',
  find(content, oldString) {
    const trimmedOld = oldString.trim()
    const contentLines = content.split('\n')
    const oldLines = trimmedOld.split('\n')

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      let match = true
      for (let j = 0; j < oldLines.length; j++) {
        if (contentLines[i + j].trim() !== oldLines[j].trim()) {
          match = false
          break
        }
      }
      if (match) {
        const actualMatch = contentLines.slice(i, i + oldLines.length).join('\n')
        const allMatches = findAllOccurrences(content, actualMatch)
        return { match: actualMatch, index: allMatches[0].index, count: allMatches.length }
      }
    }
    return null
  },
}

const replacers: Replacer[] = [
  exactReplacer,
  lineTrimReplacer,
  indentNormalizeReplacer,
  whitespaceFoldReplacer,
  escapeNormalizeReplacer,
  wholeTrimReplacer,
]

/**
 * Try each replacer in order. First one that yields a unique match wins.
 */
export function replace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): ReplaceResult | ReplaceError {
  let foundMultiple = false

  for (const replacer of replacers) {
    const result = replacer.find(content, oldString, replaceAll)
    if (!result) continue
    if (result.count > 1 && !replaceAll) {
      foundMultiple = true
      continue
    }
    if (replaceAll) {
      return { content: content.split(result.match).join(newString) }
    }
    return {
      content: content.slice(0, result.index) + newString + content.slice(result.index + result.match.length),
    }
  }

  if (foundMultiple) {
    return { error: 'old_string not unique, provide more context', notFound: false }
  }
  return { error: 'old_string not found in file', notFound: true }
}
