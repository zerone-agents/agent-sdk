import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillRegistry } from './registry.js'
import { loadSkillsFromFilesystem } from './filesystem.js'

describe('loadSkillsFromFilesystem', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'skills-fs-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('loads project skills into the given registry with source=project', async () => {
    const dir = join(cwd, '.agents', 'skills', 'my-skill')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: my-skill\ndescription: test skill\n---\nDo the thing.\n')

    const registry = new SkillRegistry()
    const result = await loadSkillsFromFilesystem(cwd, ['project'], {}, registry)

    expect(result.loaded).toBe(1)
    expect(registry.get('my-skill')?.source).toBe('project')
  })

  it('returns { loaded: 0 } when settingSources is empty', async () => {
    const registry = new SkillRegistry()
    const result = await loadSkillsFromFilesystem(cwd, [], {}, registry)
    expect(result.loaded).toBe(0)
  })

  it('does not touch the defaultRegistry', async () => {
    const dir = join(cwd, '.agents', 'skills', 'isolated-skill')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: isolated-skill\ndescription: x\n---\nBody.\n')

    const { getSkill } = await import('./registry.js')
    const registry = new SkillRegistry()
    await loadSkillsFromFilesystem(cwd, ['project'], {}, registry)
    expect(getSkill('isolated-skill')).toBeUndefined()
  })

  // Regression for issue #97: a skill loaded via extraProjectSkillDirs must be
  // tagged source='project' regardless of its absolute path, so it passes the
  // allowlist filter even when cwd (and therefore the project skill dir) sits
  // under $HOME. The cwd here is under os.tmpdir() which on macOS is under
  // /var/folders — emulate the $HOME-under-path condition by pointing
  // extraProjectSkillDirs at a sibling dir that itself contains the skill.
  it('tags extraProjectSkillDirs skills as project even when located under $HOME', async () => {
    // Place the skill directory OUTSIDE cwd but under $HOME-like temp root,
    // then reference it via extraProjectSkillDirs.
    const projectSkillsRoot = await mkdtemp(join(tmpdir(), 'project-skills-'))
    const skillDir = join(projectSkillsRoot, 'extra-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: extra-skill\ndescription: x\n---\nBody.\n',
    )

    const registry = new SkillRegistry()
    await loadSkillsFromFilesystem(
      cwd,
      ['project'],
      { extraProjectSkillDirs: [projectSkillsRoot] },
      registry,
    )

    const skill = registry.get('extra-skill')
    expect(skill).toBeDefined()
    expect(skill?.source).toBe('project')

    // Project-sourced skills must clear the allowlist without being named.
    const { filterSkillsByAllowlist } = await import('./registry.js')
    expect(filterSkillsByAllowlist([skill!], ['unrelated-skill'])).toHaveLength(1)

    await rm(projectSkillsRoot, { recursive: true, force: true })
  })

  // Regression for issue #97 (symlink case): a skill directory that is itself
  // a symlink must be loaded and tagged the same as a regular directory.
  it('loads symlinked skill directories under extraProjectSkillDirs with source=project', async () => {
    if (process.platform === 'win32') {
      // Symlinks on Windows require elevated privileges; skip.
      return
    }

    const projectSkillsRoot = await mkdtemp(join(tmpdir(), 'project-symlink-'))
    const realSkillDir = join(projectSkillsRoot, 'linked-skill.real')
    await mkdir(realSkillDir, { recursive: true })
    await writeFile(
      join(realSkillDir, 'SKILL.md'),
      '---\nname: linked-skill\ndescription: x\n---\nBody.\n',
    )

    // Create the skill directory entry as a symlink pointing at the real dir.
    const symlinkedSkillDir = join(projectSkillsRoot, 'linked-skill')
    await symlink(realSkillDir, symlinkedSkillDir, 'dir')

    const registry = new SkillRegistry()
    await loadSkillsFromFilesystem(
      cwd,
      ['project'],
      { extraProjectSkillDirs: [projectSkillsRoot] },
      registry,
    )

    const skill = registry.get('linked-skill')
    expect(skill).toBeDefined()
    expect(skill?.source).toBe('project')

    await rm(projectSkillsRoot, { recursive: true, force: true })
  })

  // Nested directory support: SKILL.md can live at any depth under the
  // skill root, not just one level deep. The skill name is the immediate
  // parent directory of SKILL.md.
  it('loads skills from nested subdirectories (e.g. skills/team/commit/SKILL.md)', async () => {
    // Build a tree:
    //   .agents/skills/
    //   ├── flat-commit/SKILL.md              (1 level — backward compat)
    //   ├── team-a/commit/SKILL.md            (2 levels — nested)
    //   └── team-b/sub/deep-review/SKILL.md   (3 levels — deeply nested)
    const root = join(cwd, '.agents', 'skills')
    await mkdir(join(root, 'flat-commit'), { recursive: true })
    await mkdir(join(root, 'team-a', 'commit'), { recursive: true })
    await mkdir(join(root, 'team-b', 'sub', 'deep-review'), { recursive: true })

    await writeFile(join(root, 'flat-commit', 'SKILL.md'),
      '---\nname: flat-commit\ndescription: x\n---\nBody.\n')
    await writeFile(join(root, 'team-a', 'commit', 'SKILL.md'),
      '---\nname: nested-commit\ndescription: x\n---\nBody.\n')
    await writeFile(join(root, 'team-b', 'sub', 'deep-review', 'SKILL.md'),
      '---\nname: deep-review\ndescription: x\n---\nBody.\n')

    const registry = new SkillRegistry()
    const result = await loadSkillsFromFilesystem(cwd, ['project'], {}, registry)

    expect(result.loaded).toBe(3)
    expect(registry.get('flat-commit')).toBeDefined()
    expect(registry.get('nested-commit')).toBeDefined()
    expect(registry.get('deep-review')).toBeDefined()

    // skillName is derived from immediate parent dir, not the path
    const deep = registry.get('deep-review')!
    expect(deep.skillDir).toBe(join(root, 'team-b', 'sub', 'deep-review'))
  })

  // frontmatter.name takes precedence over the directory name when present.
  it('lets frontmatter.name override the parent directory name', async () => {
    const root = join(cwd, '.agents', 'skills')
    await mkdir(join(root, 'some-dir-name'), { recursive: true })
    await writeFile(join(root, 'some-dir-name', 'SKILL.md'),
      '---\nname: actual-skill-name\ndescription: x\n---\nBody.\n')

    const registry = new SkillRegistry()
    await loadSkillsFromFilesystem(cwd, ['project'], {}, registry)

    expect(registry.get('actual-skill-name')).toBeDefined()
    expect(registry.get('some-dir-name')).toBeUndefined()
  })

  // When two SKILL.md files resolve to the same skill name, later-loaded wins.
  // Loading order: user → extraUser → project → extraProject.
  it('lets project skills override user skills with the same name', async () => {
    const userRoot = await mkdtemp(join(tmpdir(), 'user-skills-'))
    const projectRoot = join(cwd, '.agents', 'skills')

    // User-level skill
    await mkdir(join(userRoot, 'shared'), { recursive: true })
    await writeFile(join(userRoot, 'shared', 'SKILL.md'),
      '---\nname: shared\ndescription: user version\n---\nUser body.\n')

    // Project-level skill (same name, different content)
    await mkdir(join(projectRoot, 'shared'), { recursive: true })
    await writeFile(join(projectRoot, 'shared', 'SKILL.md'),
      '---\nname: shared\ndescription: project version\n---\nProject body.\n')

    // Force user dir to be the user home for this test
    const originalHome = process.env.HOME
    process.env.HOME = userRoot
    try {
      const registry = new SkillRegistry()
      await loadSkillsFromFilesystem(cwd, ['user', 'project'], {}, registry)

      const skill = registry.get('shared')
      expect(skill).toBeDefined()
      expect(skill!.description).toBe('project version')
    } finally {
      process.env.HOME = originalHome
      await rm(userRoot, { recursive: true, force: true })
    }
  })

  // SKILL.md at the top level of a skill root (no parent skill dir) is also
  // matched by the ** glob pattern. Skill name = basename(root).
  it('loads a top-level SKILL.md directly under the skills root', async () => {
    const root = join(cwd, '.agents', 'skills')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'SKILL.md'),
      '---\nname: root-skill\ndescription: x\n---\nBody.\n')

    const registry = new SkillRegistry()
    await loadSkillsFromFilesystem(cwd, ['project'], {}, registry)

    // fs.glob('**/SKILL.md') matches top-level too; the skill name falls back
    // to the basename of the cwd since dirname(SKILL.md) === root === 'skills'.
    // With frontmatter.name set, that wins.
    const skill = registry.get('root-skill')
    expect(skill).toBeDefined()
    expect(skill!.skillDir).toBe(root)
  })

  // ${ZERONE_AGENT_SKILL_DIR} placeholder in SKILL.md body is replaced with
  // the absolute path to the skill's directory.
  it('substitutes ${ZERONE_AGENT_SKILL_DIR} in the SKILL.md body', async () => {
    const root = join(cwd, '.agents', 'skills', 'pathy')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'SKILL.md'),
      '---\nname: pathy\ndescription: x\n---\nDir is ${ZERONE_AGENT_SKILL_DIR}\n')

    const registry = new SkillRegistry()
    await loadSkillsFromFilesystem(cwd, ['project'], {}, registry)

    const skill = registry.get('pathy')!
    const blocks = await skill.getPrompt('', {} as any)
    const text = (blocks[0] as { type: 'text'; text: string }).text
    expect(text).toContain(`Dir is ${root}`)
    expect(text).not.toContain('${ZERONE_AGENT_SKILL_DIR}')
  })
})
