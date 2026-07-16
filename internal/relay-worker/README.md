# CXX Internal Official Relay

This directory contains the versioned official Wokey relay deployment overlay.
Public self-hosting files stay in `relay/worker/`; official source and config
declarations are tracked so a clean checkout can reproduce the deployment.
All credentials remain in Wrangler secrets. The non-sensitive Cloudflare
account ID is versioned as a normal Worker variable.

Current target:

- Worker name: `codex-zh-relay`
- Route: `relay.wokey.ai/*`
- Main: `src/worker.official.mjs`

Relay request quota and reconnect hardening plan:

- [`../RELAY-QUOTA-HARDENING.md`](../RELAY-QUOTA-HARDENING.md)

The Worker name is intentionally `codex-zh-relay` because that is the current
shared production Worker bound to `relay.wokey.ai`. Changing it back to
`cxx-relay` is a route and Durable Object namespace migration, not a routine
stats deploy.

Secrets are not stored here. Set them with:

```sh
npx wrangler secret put -c internal/relay-worker/wrangler.official.toml STATS_TOKEN
npx wrangler secret put -c internal/relay-worker/wrangler.official.toml CF_API_TOKEN
npx wrangler secret put -c internal/relay-worker/wrangler.official.toml TG_BOT_TOKEN
npx wrangler secret put -c internal/relay-worker/wrangler.official.toml TG_CHAT_ID
```

Deploy from the repo root:

```sh
npx wrangler deploy -c internal/relay-worker/wrangler.official.toml
```

Use `--dry-run` first when changing the internal entrypoint.
