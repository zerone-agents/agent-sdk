/**
 * Example 15: Nested Filesystem Skills
 *
 * Demonstrates the nested skill directory structure supported by
 * loadSkillsFromFilesystem (uses fs.promises.glob under the hood).
 *
 * Skills can be organized at any depth. The skill name is the immediate
 * parent directory of SKILL.md, unless overridden by frontmatter.name.
 *
 * Tree built by this example:
 *
 *   .test-example-15/.agents/skills/
 *   ├── flat-commit/SKILL.md                  (1 level — skill name: flat-commit)
 *   ├── team-a/nested-review/SKILL.md         (2 levels — skill name: nested-review)
 *   └── team-b/sub/deep-plan/SKILL.md         (3 levels — skill name: deep-plan)
 *
 * Run: npx tsx examples/skills/15-nested-skills.ts
 */
import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { createAgent } from '../../src/index.js'

async function main() {
  console.log('=== Example 15: Nested Filesystem Skills ===\n')

  // Setup: build a nested skill tree under a temp project root
  const testDir = join(process.cwd(), '.test-example-15')
  const skillsRoot = join(testDir, '.agents', 'skills')

  await mkdir(join(skillsRoot, 'flat-commit'), { recursive: true })
  await mkdir(join(skillsRoot, 'team-a', 'nested-review'), { recursive: true })
  await mkdir(join(skillsRoot, 'team-b', 'sub', 'deep-plan'), { recursive: true })

  await writeFile(join(skillsRoot, 'flat-commit', 'SKILL.md'), `---
name: flat-commit
description: One-level-deep skill
---

# Flat Commit

Body of the flat-commit skill.
Path resolved via: \${ZERONE_AGENT_SKILL_DIR}
`)

  await writeFile(join(skillsRoot, 'team-a', 'nested-review', 'SKILL.md'), `---
name: nested-review
description: Two-level-deep skill nested under team-a
---

# Nested Review

Body of the nested-review skill.
Directory: \${ZERONE_AGENT_SKILL_DIR}
`)

  await writeFile(join(skillsRoot, 'team-b', 'sub', 'deep-plan', 'SKILL.md'), `---
name: deep-plan
description: Three-level-deep skill nested under team-b/sub
---

# Deep Plan

Body of the deep-plan skill.
Directory: \${ZERONE_AGENT_SKILL_DIR}
`)

  // Bonus: frontmatter.name override — directory is "renamed-skill" but
  // frontmatter declares "actual-name". Demonstrates that frontmatter wins.
  await mkdir(join(skillsRoot, 'renamed-skill'), { recursive: true })
  await writeFile(join(skillsRoot, 'renamed-skill', 'SKILL.md'), `---
name: actual-name
description: Demonstrates frontmatter.name overriding directory name
---

# Actual Name

The directory is renamed-skill, but frontmatter.name wins.
`)

  try {
    const agent = createAgent({
      cwd: testDir,
      settingSources: ['project'],
      agent: {
        description: 'Nested skills agent',
        prompt: 'You are a skills loader test agent. Do not call any tools.',
        maxTurns: 1,
      },
    })

    await agent['setupDone']

    // Inspect loaded skills (read from the agent's own overlay registry,
    // not the module-level defaultRegistry)
    const skills = agent.skillRegistry.getAll().filter(s => s.source === 'project')
    console.log(`Loaded ${skills.length} project skills:\n`)

    const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name))
    for (const s of sorted) {
      console.log(`  ${s.name}`)
      console.log(`    description: ${s.description}`)
      console.log(`    skillDir:    ${s.skillDir}`)
      console.log(`    location:    ${s.location}`)
      console.log()
    }

    // Verify each expected skill
    const expected = ['actual-name', 'deep-plan', 'flat-commit', 'nested-review']
    console.log('=== Verification ===')
    for (const name of expected) {
      const found = skills.find(s => s.name === name)
      console.log(`  ${found ? '✓' : '✗'} ${name}`)
    }

    // Show frontmatter override
    const renamed = skills.find(s => s.name === 'actual-name')
    const dirName = renamed?.skillDir?.split('/').pop()
    console.log(`\n=== Frontmatter Override ===`)
    console.log(`  Directory name: ${dirName}`)
    console.log(`  Registered as:  ${renamed?.name}`)
    console.log(`  frontmatter wins: ${dirName !== renamed?.name ? 'yes' : 'no'}`)

    // Demonstrate variable substitution on a skill that uses the placeholder
    const flat = skills.find(s => s.name === 'flat-commit')
    if (flat) {
      const blocks = await flat.getPrompt('', {} as any)
      const text = (blocks[0] as { type: 'text'; text: string }).text
      console.log(`\n=== Variable Substitution (flat-commit) ===`)
      console.log(`  \${ZERONE_AGENT_SKILL_DIR} replaced: ${!text.includes('${ZERONE_AGENT_SKILL_DIR}')}`)
      console.log(`  Rendered body contains skillDir: ${text.includes(flat.skillDir!)}`)
    }

    await agent.close()
    console.log('\n✓ Example completed successfully')
  } finally {
    await rm(testDir, { recursive: true, force: true })
  }
}

main().catch(console.error)
