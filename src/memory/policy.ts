import type { MemoryPolicyFinding } from './errors.js'
import type { MemoryScope } from './types.js'

export type { MemoryPolicyFinding } from './errors.js'

export interface MemoryContentPolicyInput {
  /** Trimmed content (service trims before invoking policy). */
  content: string
  scope: MemoryScope
}

/**
 * Additional host content policy. Any `error` finding rejects the mutation
 * with MemoryValidationError; `warning` findings go to diagnostics only.
 * Structural checks (empty/control chars/duplicates/budgets) and context
 * escaping are NOT policy — the service always enforces them.
 */
export type MemoryContentPolicy = (input: MemoryContentPolicyInput) => MemoryPolicyFinding[]

/** Mask a matched secret: first 4 + ellipsis + last 2, never the complete value. */
export function maskSecret(match: string): string {
  if (match.length <= 6) return `${match.slice(0, 2)}…`
  return `${match.slice(0, 4)}…${match.slice(-2)}`
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/,                    // OpenAI/Anthropic-style API keys
  /AKIA[0-9A-Z]{16}/,                          // AWS access key ID
  /ghp_[A-Za-z0-9]{36}/,                       // GitHub personal access token
  /xox[baprs]-[A-Za-z0-9-]{10,}/,              // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,        // PEM private keys
]

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any )?(previous|prior|above) instructions/i,
  /disregard (all |any )?(previous|prior|above) instructions/i,
  /you are now (a|an|in) /i,
  /new system prompt/i,
]

export function createDefaultMemoryContentPolicy(): MemoryContentPolicy {
  return ({ content }) => {
    const findings: MemoryPolicyFinding[] = []
    for (const pattern of SECRET_PATTERNS) {
      const match = pattern.exec(content)
      if (match) {
        findings.push({
          code: 'secret.detected',
          severity: 'error',
          message: `Content matches a credential format (${maskSecret(match[0])}); refusing to persist.`,
        })
        break // one secret error per mutation is actionable; more adds noise
      }
    }
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        findings.push({
          code: 'prompt_injection.phrase',
          severity: 'warning',
          message: 'Content contains a phrase associated with prompt-injection attempts.',
        })
        break
      }
    }
    return findings
  }
}