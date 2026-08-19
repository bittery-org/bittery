# Releasing Bittery

Bittery uses one version for the server, web app, desktop app, mobile app, and browser extension. Stable Git tags are the record of published versions, while the version files on `main` describe the latest release or the release currently being prepared.

Maintainers normally release entirely through GitHub. Do not edit version files or create release tags by hand.

## Prepare a release

1. Open the repository's **Actions** tab.
2. Select **Prepare release**.
3. Choose **Run workflow** from `main`. The workflow refuses to run from any other branch.
4. Select the version change:
   - `patch` for compatible fixes, such as `0.4.1` to `0.4.2`.
   - `minor` for compatible features, such as `0.4.1` to `0.5.0`.
   - `major` for breaking changes, such as `0.4.1` to `1.0.0`.
5. Run the workflow.

The workflow calculates the next version from whichever is newer, the latest stable `v*` tag or the version already on `main`. Bumping from the tag alone would walk the version backwards whenever a release pull request merged but tagging failed. It then updates every release surface, formats the affected JSON files, verifies the result, pushes `release/vX.Y.Z`, opens a release pull request, and starts CI for that branch.

Running the workflow again for the same version updates the existing release branch and pull request rather than creating another release.

## Review the release pull request

Before merging:

- Confirm the proposed version is appropriate.
- Review the comparison link in the pull request description.
- Confirm user-facing changes are ready to publish.
- Wait for all required CI checks to pass.
- Edit the pull request description if maintainers need additional release context.

The release pull request must keep its generated `release/vX.Y.Z` branch name and hidden release marker. The tagging workflow uses both to distinguish a prepared release from an ordinary pull request.

The full Web E2E suite runs on release pull requests, scheduled verification, and explicit manual CI runs. Ordinary pull requests and pushes to `main` keep the faster static, unit, integration, and server checks without repeating Web E2E.

Merging the release pull request is the publication decision. Do not merge it until the release should begin.

## What happens after merge

The **Tag release** workflow checks out the exact merge commit and verifies that:

- Every tracked release surface contains the same version.
- The repository version is not behind release history.
- The release branch, pull request marker, and repository version agree.
- The proposed version is newer than the latest stable release.
- The target tag does not already exist.

It then creates an annotated `vX.Y.Z` tag on the merge commit and dispatches the **Release** workflow for that tag.

The release workflow validates the tag against the repository before building anything. It then builds and publishes the server and web container images, desktop installers, browser extension archive, checksums, provenance attestations, and GitHub Release.

## Release notes and changelog

GitHub generates release notes from pull requests merged since the previous release. `.github/release.yml` groups those changes into Security, Features, Fixes, Maintenance, and Other changes.

Apply accurate labels to pull requests so the generated notes stay useful. Add the `skip-changelog` label to work that should not appear in release notes.

The GitHub Release is currently the project changelog. If Bittery later adds a tracked `CHANGELOG.md`, generate and review its new section in the release pull request. The tag-triggered build must remain read-only with respect to repository version and changelog files.

## Version safeguards

`pnpm run version:check` verifies both internal consistency and release history. It checks:

- Root `package.json`
- Desktop and extension `package.json`
- Desktop `tauri.conf.json`
- Mobile `app.json`
- Server and desktop `Cargo.toml`
- The Bittery package entries in the server and desktop Cargo lockfiles

The browser extension manifest is not on that list because `apps/extension/manifest.config.js` derives its version from `apps/extension/package.json`, so it cannot drift.

The repository version may equal the latest tag immediately after publication, but it may never be lower. Release preparation additionally requires a strictly newer version.

The history check needs the release tags, so every job that runs it must check out with `fetch-depth: 0`. Missing tags fail the check rather than skipping it silently; a repository that has genuinely never released can pass `--allow-no-releases` for its first release.

For local diagnosis, these commands do not publish anything:

```bash
pnpm run version:check
node --test "scripts/**/*.test.mjs"
```

`pnpm run version:sync -- X.Y.Z` remains available for repairing version drift on a development branch. Run Biome over the changed JSON files afterward and submit the repair through a normal pull request. It must not be used as a substitute for the **Prepare release** workflow.

## Failures and recovery

### Preparation fails

Fix the reported problem on `main`, then run **Prepare release** again. No tag or published artifact exists at this stage.

### CI fails on the release pull request

Fix the failure before merging. For a release-only correction, update the generated release branch through a reviewed commit. Re-running **Prepare release** resets that branch from current `main`, reapplies the version, and updates the pull request.

### Tagging fails after merge

Do not create a different tag or increment the version to work around the failure. Inspect the **Tag release** run and repair the automation or inconsistent repository state. Re-run the failed job only when its validations are satisfied and `vX.Y.Z` still does not exist.

### Publication fails after the tag exists

The tag is immutable release identity and must not be moved or reused. Re-run the failed **Release** jobs after correcting transient infrastructure or credentials. If the tagged source itself is defective, prepare a new patch release instead of replacing the tag.

### A release must be cancelled

Close an unmerged release pull request and delete its generated release branch. Once the release pull request has been merged and the tag exists, do not delete or rewrite the tag; follow up with a patch release when necessary.
