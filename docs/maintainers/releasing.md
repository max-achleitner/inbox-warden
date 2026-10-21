# Releasing Inbox Warden

## One-time setup

1. **npm:** publish the first version manually from a trusted machine with 2FA
   (`npm publish --access public` after `npm run build`). Then on npmjs.com → package
   **inbox-warden** → Settings → **Trusted Publisher** → GitHub Actions: owner `max-achleitner`,
   repository `inbox-warden`, workflow `release.yml`, environment `release`. Afterwards set
   "Require two-factor authentication and disallow tokens".
2. **GitHub environment `release`** (Settings → Environments): required reviewer = you; deployment
   branches/tags = tags matching `v*.*.*`; signing is paused (see `release-signing.md`), so no signing secrets are needed.
3. **Tag protection** (Settings → Rules → new tag ruleset for `v*`): only maintainers may create tags.

## Every release

1. Move the entries under `## [Unreleased]` in `CHANGELOG.md` into `## [x.y.z] - YYYY-MM-DD`.
2. `npm version x.y.z` — bumps `package.json`, syncs the plugin manifest (npm `version` hook), commits and tags `vx.y.z`.
3. `git push origin master --follow-tags`.
4. Approve the `release` environment once when the `publish` job asks.
5. Check the release page: `.mcpb` (unsigned since 0.7.0; the workflow's ZIP check passed), `.tgz`, SBOM and `SHA256SUMS` attached; `npm view inbox-warden@x.y.z dist.attestations` shows provenance.
6. `claude plugin marketplace update achleitner && claude plugin update inbox-warden@achleitner` installs the new bundle.

The plugin manifest on `master` points at the new release URL from step 3 on; installs started before the
release job finishes (≈ 15 minutes) fail with a download error and succeed when retried.

## Release candidates

Tag release candidates from a branch so `master` (and with it the plugin marketplace) keeps pointing at the
last stable bundle: `git switch -c rc/x.y.z && npm version x.y.z-rc.1 && git push origin rc/x.y.z --follow-tags`.
The workflow publishes versions containing `-` with the npm dist-tag `next` and marks the GitHub release as a
pre-release, so `npm install inbox-warden` keeps installing the stable version. Delete the branch afterwards.

## Verifying a release (for administrators)

```bash
sha256sum -c SHA256SUMS
gh attestation verify inbox-warden-x.y.z.mcpb --repo max-achleitner/inbox-warden
npm audit signatures   # in a project that installed inbox-warden
```

`scripts/verify-mcpb.mjs` is for 0.6.0 only; later bundles carry no signature.
