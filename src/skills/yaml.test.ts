import { describe, it, expect } from 'vitest'
import { parseSkillMarkdown } from './yaml.js'

describe('parseSkillMarkdown', () => {
  it('parses single-line description', () => {
    const md = `---
name: foo
description: A simple skill.
---
body`
    const { frontmatter, body } = parseSkillMarkdown(md)
    expect(frontmatter.name).toBe('foo')
    expect(frontmatter.description).toBe('A simple skill.')
    expect(body).toBe('body')
  })

  it('parses folded block scalar (description: >)', () => {
    const md = `---
name: foo
description: >
  Line one of the description.
  Line two continues here.
---
body`
    const { frontmatter } = parseSkillMarkdown(md)
    expect(frontmatter.description).toMatch(/Line one/)
    expect(frontmatter.description).toMatch(/Line two/)
    // Folded scalar joins indented lines with spaces (YAML spec keeps a trailing newline)
    expect(frontmatter.description).not.toMatch(/\n[^]/)
  })

  it('parses literal block scalar (description: |)', () => {
    const md = `---
name: foo
description: |
  Line 1
  Line 2
---
body`
    const { frontmatter } = parseSkillMarkdown(md)
    expect(frontmatter.description).toContain('Line 1')
    expect(frontmatter.description).toContain('Line 2')
  })

  it('handles values containing colons (URLs)', () => {
    const md = `---
name: foo
description: See https://example.com for details
---
body`
    const { frontmatter } = parseSkillMarkdown(md)
    expect(frontmatter.description).toBe('See https://example.com for details')
  })

  it('strips quotes from values', () => {
    const md = `---
name: "quoted name"
description: 'single quoted'
---
body`
    const { frontmatter } = parseSkillMarkdown(md)
    expect(frontmatter.name).toBe('quoted name')
    expect(frontmatter.description).toBe('single quoted')
  })

  it('ignores unknown fields (e.g. agent_created)', () => {
    const md = `---
name: foo
description: bar
agent_created: true
unknown_field: whatever
---
body`
    const { frontmatter } = parseSkillMarkdown(md)
    expect(frontmatter.description).toBe('bar')
    expect((frontmatter as any).agent_created).toBeUndefined()
    expect((frontmatter as any).unknown_field).toBeUndefined()
  })

  it('supports array fields', () => {
    const md = `---
name: foo
description: bar
aliases:
  - a
  - b
---
body`
    const { frontmatter } = parseSkillMarkdown(md)
    expect(frontmatter.aliases).toEqual(['a', 'b'])
  })

  it('supports comma-separated string arrays', () => {
    const md = `---
name: foo
description: bar
aliases: a, b, c
---
body`
    const { frontmatter } = parseSkillMarkdown(md)
    expect(frontmatter.aliases).toEqual(['a', 'b', 'c'])
  })

  it('supports YAML comments', () => {
    const md = `---
# This is a comment
name: foo  # inline comment
description: bar
---
body`
    const { frontmatter } = parseSkillMarkdown(md)
    expect(frontmatter.name).toBe('foo')
    expect(frontmatter.description).toBe('bar')
  })

  it('throws when description is missing', () => {
    const md = `---
name: foo
---
body`
    expect(() => parseSkillMarkdown(md)).toThrow(/description/)
  })

  it('throws when description is empty', () => {
    const md = `---
name: foo
description: ""
---
body`
    expect(() => parseSkillMarkdown(md)).toThrow(/description/)
  })

  it('throws on malformed YAML', () => {
    const md = `---
name: foo: bar
description: baz
---
body`
    expect(() => parseSkillMarkdown(md)).toThrow(/Invalid YAML frontmatter/)
  })

  it('throws when frontmatter delimiters are missing', () => {
    expect(() => parseSkillMarkdown('no frontmatter here')).toThrow(
      /missing frontmatter/,
    )
  })

  it('normalizes CRLF line endings', () => {
    const md = `---\r\nname: foo\r\ndescription: bar\r\n---\r\nbody`
    const { frontmatter, body } = parseSkillMarkdown(md)
    expect(frontmatter.name).toBe('foo')
    expect(frontmatter.description).toBe('bar')
    expect(body).toBe('body')
  })

  it('strips BOM from start of file', () => {
    const md = `\uFEFF---
name: foo
description: bar
---
body`
    const { frontmatter } = parseSkillMarkdown(md)
    expect(frontmatter.name).toBe('foo')
  })

  it('parses boolean user-invocable field', () => {
    const md = `---
name: foo
description: bar
user-invocable: false
---
body`
    const { frontmatter } = parseSkillMarkdown(md)
    expect(frontmatter.userInvocable).toBe(false)
  })

  // ── Real-world regression: skillhub standard format ──────────────
  it('parses skillhub pharmaceutical-care-pathway (folded multi-lingual)', () => {
    const md = `---
name: pharmaceutical-care-pathway
description: >
  药学监护路径生成技能。This skill should be used when the user needs to generate a pharmaceutical care pathway
  (药学监护路径) for a specific clinical diagnosis. The workflow includes: (1) analyzing clinical guidelines or
  pathways for the diagnosis to generate a treatment timeline diagram; (2) generating pharmaceutical care
  sub-category worksheets (drug reconciliation, prescription review, medication education, etc.) with
  standardized form templates per Chinese Hospital Association pharmaceutical service standards;
  (3) producing a time-sequenced pharmaceutical care plan table and an HTML-formatted pharmaceutical care plan
  document with patient demographics, diagnosis, treatment plan, and care activities.
  Trigger when user mentions: 药学监护路径、临床路径药学、药学查房路径、药学监护计划、某疾病的药学监护。
agent_created: true
---
# 药学监护路径生成技能`
    const { frontmatter } = parseSkillMarkdown(md)
    expect(frontmatter.name).toBe('pharmaceutical-care-pathway')
    // The bug we're fixing: description must NOT be ">"
    expect(frontmatter.description).not.toBe('>')
    // Must contain the real content
    expect(frontmatter.description).toMatch(/药学监护路径生成技能/)
    expect(frontmatter.description).toMatch(/Trigger when user mentions/)
    expect(frontmatter.description).toMatch(/pharmaceutical care pathway/)
    // Unknown field agent_created must be dropped
    expect((frontmatter as any).agent_created).toBeUndefined()
  })
})
