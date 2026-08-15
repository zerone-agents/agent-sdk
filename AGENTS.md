# Agent Instructions

## Release Process

Publishing: push tag `sdk-vX.Y.Z` on `main` → `ci-publish.yml` runs `npm publish` automatically.

1. On `main`, verify green: `npm run typecheck` + `npx vitest run`.
2. Branch `chore/release-vX.Y.Z`, run `npm version X.Y.Z --no-git-tag-version`, commit **both** `package.json` and `package-lock.json`, PR, merge after CI passes.
3. Back on `main` (pulled): `git tag sdk-vX.Y.Z && git push origin sdk-vX.Y.Z`, then verify `npm view @zerone-agent/agent-sdk version`.
4. Create the GitHub Release manually (workflow does NOT): `npm pack --pack-destination /tmp`, then `gh release create sdk-vX.Y.Z /tmp/zerone-agent-agent-sdk-X.Y.Z.tgz --title "SDK vX.Y.Z" --notes "..."` — notes must flag any breaking/behavior changes with migration steps.
5. Clean up local tarballs (`*.tgz` is gitignored).
