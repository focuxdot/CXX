# CXX Relay Worker

This directory is the public, self-hostable relay Worker.

- `wrangler.toml` deploys `src/worker.mjs` as `cxx-relay`.
- `src/worker.mjs` is the public entrypoint and must stay zero-knowledge: no
  `relay.wokey.ai` route, no `/admin/stats`, no Analytics Engine binding, no
  Telegram notification code, and no operator secrets.
- `src/relay-core.mjs` contains the shared relay protocol implementation used by
  both public and internal entrypoints.

Official Wokey deployment files live under the versioned `internal/relay-worker/`
directory. That entrypoint imports `src/relay-core.mjs` and layers in operator-only
stats and notifications without forking the relay protocol; credentials and
tokens remain in Wrangler secrets.
