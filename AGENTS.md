# AGENTS.md

## CI

- **Development CI runs only by explicit dispatch, one run at a time** (owner, 2026-11-14).
  Only the leader dispatches `ci.yml` on the latest ref; teammates ask the leader. Batch suites
  and changes into one run. The `dev-ci` group lets a running run finish and replaces a queued
  run with the newest dispatch. Release, tag, release-sync, publishing and Pages triggers remain.
