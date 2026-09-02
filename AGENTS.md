# Agent Instructions

## Terminology

Two distinct concepts MUST be named differently to prevent semantic drift:

- **query** — one user↔assistant exchange: a *real* user prompt (a user message that is not merely a `tool_result` carrier) plus every assistant/`tool_use`/`tool_result` round-trip that follows, up to the next real user prompt. This is the unit of conversation history that compaction protects/prunes and that session truncation counts.
- **turn** — one iteration of the agent's internal LLM loop: a single provider request/response, including the `tool_use` → `tool_result` round-trips that occur *within* the current query. Loop guards, provider-call counters, and per-iteration logic refer to turns.

The conversation-history unit has always conceptually been a **query**. Any existing `…Turn(s)` identifier used for that unit is incorrectly named and should be renamed directly to query terminology (`…Queries`, `isUserQuery`, `TOOL_PROTECTED_QUERIES`, etc.). Do not preserve deprecated aliases for those incorrect names.

Reserve **turn** strictly for LLM loop iterations. Do NOT introduce or retain `…Turn(s)` identifiers for the conversation-history unit. Identifiers such as `maxTurns` remain correct when they count provider-loop iterations rather than conversation queries.

## Release Process

Publishing: push tag `sdk-vX.Y.Z` on `main` → `ci-publish.yml` runs `npm publish` automatically.

1. On `main`, verify green: `npm run typecheck` + `npx vitest run`.
2. Branch `chore/release-vX.Y.Z`, run `npm version X.Y.Z --no-git-tag-version`, commit **both** `package.json` and `package-lock.json`, PR, merge after CI passes.
3. Back on `main` (pulled): `git tag sdk-vX.Y.Z && git push origin sdk-vX.Y.Z`, then verify `npm view @zerone-agent/agent-sdk version`.
4. Create the GitHub Release manually (workflow does NOT): `npm pack --pack-destination /tmp`, then `gh release create sdk-vX.Y.Z /tmp/zerone-agent-agent-sdk-X.Y.Z.tgz --title "SDK vX.Y.Z" --notes "..."` — notes must flag any breaking/behavior changes with migration steps.
5. Clean up local tarballs (`*.tgz` is gitignored).
