---
name: release
description:
  Prepare and publish a release of this repository, verifying all GitHub CI on
  the release commit and tag before publishing. Use for version bumps and
  release requests here.
---

Honor the requested version and scope. A request to prepare a release does not
authorize publishing it; a request to create or publish a release does. Existing
authorization carries through the workflow without another confirmation.

## Prepare

- Inspect Git status, the remote default branch, existing tags/releases, and
  `.github/workflows/`. Include only the authorized changes.
- Keep `package.json`, the root and `packages[""]` versions in
  `package-lock.json`, and `plugins/claude/.codex-plugin/plugin.json` aligned.
  Published versions must not contain a development cachebuster.
- Follow [lint](../lint/SKILL.md), [format](../format/SKILL.md), and
  [test](../test/SKILL.md). Run `npm run check` after the final edits. Tests
  must use the fake Claude CLI.
- Prepare release notes describing the shipped fixes, limitations, and
  validation. Write multiline notes to a temporary file for `--notes-file`.
- Commit and push the authorized changes. Record the full release commit SHA. If
  a pull request is required, wait for its checks and merge through the
  repository's normal process, then use the actual merged SHA.

## Require green GitHub CI

Local checks and a Claude stop-hook ALLOW do not replace GitHub CI. **Do not
create or publish a GitHub release until every applicable workflow and matrix
job has completed successfully on the exact release commit.**

1. Query runs for the commit, not merely the latest run or a version label:

   ```sh
   gh run list --commit "$release_sha" --limit 100 \
     --json databaseId,headSha,headBranch,event,status,conclusion,url
   gh run view "$run_id" --json headSha,status,conclusion,jobs,url
   ```

2. Verify the expected workflows against `.github/workflows/` and inspect each
   matrix job. The current check matrix covers Ubuntu and macOS with Node 22
   and 24. Also inspect commit check runs and status contexts if other CI
   integrations are configured. Paginate when necessary.
3. Wait for all applicable runs and jobs. Missing runs, pending, queued,
   in-progress, failed, cancelled, skipped, or timed-out checks are not success.
   Check both branch and tag runs; a successful tag run must never hide a failed
   branch run. Keep the user informed while waiting.
4. On failure, read the failed logs and fix the cause. Push the fix and restart
   verification for the new SHA. Rerun only a diagnosed transient failure;
   inspect the new attempt and do not retry blindly until green. A blocked or
   unverifiable check leaves the release unpublished.
5. Once branch CI is green, create and push `v<version>` at that SHA. Wait for
   every tag-triggered workflow and matrix job to pass too. Do not move an
   existing release tag to a different commit.

## Publish and verify

Immediately before publishing, re-query CI for the SHA and confirm the remote
tag resolves to that same commit. All expected branch and tag runs must be
completed and successful, with no remaining failed or unfinished checks.

With publication authorized, publish using the existing verified tag:

```sh
gh release create "$release_tag" --verify-tag \
  --title "$release_tag" --notes-file "$release_notes"
```

Verify the published release and tag. Report the release URL, commit, and CI run
links. Never report a release as published while it is only prepared or while
checks remain pending.
