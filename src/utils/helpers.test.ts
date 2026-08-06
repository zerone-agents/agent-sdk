import { describe, expect, it } from 'vitest'
import { redactSensitiveFields } from './helpers.js'

describe('redactSensitiveFields', () => {
  it('redacts credential-like keys', () => {
    const input = {
      password: 'hunter2',
      token: 'tok_abc',
      api_key: 'sk-secret',
      apiKey: 'sk-secret-2',
      authorization: 'Bearer xyz',
      cookie: 'session=abc',
      secret: 'shh',
      credential: 'cred',
      private_key: '-----BEGIN',
    }
    const out = redactSensitiveFields(input) as Record<string, unknown>
    for (const key of Object.keys(input)) {
      expect(out[key], `key ${key} should be redacted`).toBe('[REDACTED]')
    }
  })

  it('redacts Bash command and multiline/heredoc content', () => {
    const out = redactSensitiveFields({
      command: 'cat <<EOF\npassword=sk-live-secret\nEOF',
    }) as Record<string, unknown>
    expect(out.command).toBe('[REDACTED]')
    expect(JSON.stringify(out)).not.toContain('sk-live-secret')
  })

  it('redacts env and headers objects entirely', () => {
    const out = redactSensitiveFields({
      command: 'curl x',
      env: { AWS_SECRET_ACCESS_KEY: 'aws-secret' },
      headers: { Authorization: 'Bearer tok' },
    }) as Record<string, unknown>
    expect(out.env).toBe('[REDACTED]')
    expect(out.headers).toBe('[REDACTED]')
    expect(JSON.stringify(out)).not.toContain('aws-secret')
    expect(JSON.stringify(out)).not.toContain('Bearer tok')
  })

  it('preserves non-sensitive fields', () => {
    const out = redactSensitiveFields({
      file_path: '/tmp/a.txt',
      pattern: 'foo',
      count: 3,
      flag: true,
    })
    expect(out).toEqual({
      file_path: '/tmp/a.txt',
      pattern: 'foo',
      count: 3,
      flag: true,
    })
  })

  it('redacts sensitive keys nested inside objects and arrays', () => {
    const out = redactSensitiveFields({
      nested: { deep: { access_token: 'nested-secret' } },
      list: [{ password: 'in-array' }, { ok: 1 }],
    }) as any
    expect(out.nested.deep.access_token).toBe('[REDACTED]')
    expect(out.list[0].password).toBe('[REDACTED]')
    expect(out.list[1].ok).toBe(1)
    expect(JSON.stringify(out)).not.toContain('nested-secret')
    expect(JSON.stringify(out)).not.toContain('in-array')
  })

  it('passes through primitives and null/undefined unchanged', () => {
    expect(redactSensitiveFields('plain string')).toBe('plain string')
    expect(redactSensitiveFields(42)).toBe(42)
    expect(redactSensitiveFields(null)).toBe(null)
    expect(redactSensitiveFields(undefined)).toBe(undefined)
  })

  it('does not mutate the original input', () => {
    const input = { token: 'tok_abc', nested: { password: 'p' } }
    redactSensitiveFields(input)
    expect(input.token).toBe('tok_abc')
    expect(input.nested.password).toBe('p')
  })
})
