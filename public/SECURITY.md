# Security model

CXX is designed so that the relay — the one component that sees every connection — can decrypt
nothing. All application content is end-to-end encrypted between the daemon (your computer) and
the client (your phone).

## End-to-end encryption

- **Key agreement:** X25519. The daemon holds a long-lived keypair; each paired client derives a
  per-connection shared secret with the daemon's public key.
- **Key derivation:** HKDF-SHA256, `salt = daemonId`, `info = "codex-zh-remote-v1"` (a frozen wire
  constant — see below), 32-byte output.
- **Symmetric cipher:** AES-256-GCM, 12-byte random IV per message.
- **Direction binding:** the GCM AAD binds message direction to prevent reflection
  (`czr1:c2d` client→daemon, `czr1:d2c` daemon→client).

The relay matches connections by `daemonId` and forwards opaque encrypted frames only. It holds
no keys or tokens. See [PROTOCOL.md](./PROTOCOL.md) for the full wire format.

### Frozen wire constants

The HKDF `info` string (`codex-zh-remote-v1`) and AAD prefixes (`czr1:*`) are **wire constants**:
the daemon and web client must agree on them byte-for-byte to derive the same session key. They
are intentionally left unchanged from the upstream lineage and are **not** rebranded — renaming
them would break interoperability and gain nothing (they are crypto domain separators, not product
names). Do not change them.

## Pairing and device tokens

- Pairing tokens are one-time and expire in 5 minutes; only their hashes are stored.
- Device tokens are long-lived credentials embedded in the pairing/permanent link; only hashes are
  stored on disk.
- Re-pairing from the same browser identity revokes that browser's prior credential (one
  browser = one device), which also invalidates any leaked older link.

## Notifications

Webhook notifications (Bark / ServerChan / WeCom / DingTalk / custom) travel over third-party
plaintext channels, so they carry **summaries only** — event type and session name. They never
include command text, code, or file paths. A deep link (page URL + session id, no content) may be
attached so tapping the notification opens the right session.

## Reporting

Please report vulnerabilities privately to the maintainers rather than opening a public issue.
