# Security Policy

## Reporting a vulnerability

Please **do not** disclose security issues in public issues, discussions or chat groups.

- Submit reports through GitHub's private security advisories: <https://github.com/karllee830/OpenHane/security/advisories/new>.
- Please include the affected components and versions, steps to reproduce or a proof of concept, and your assessment of the impact.

We will acknowledge your report within 3 business days and give an initial assessment within 7 days. Once a fix is released, we will credit you in the release notes (if you wish). Please do not disclose details before the fix is released.

## Supported versions

| Version | Security updates |
|---|---|
| Latest stable and preview releases | ✅ |
| Earlier versions | ❌ (please upgrade) |

## Scope

In scope:

- Server (`server/`): authentication, permission checks, tokens, bans, admin interfaces, TLS / TOFU, hosting of the web client.
- Clients (`clients/`): storage of identity keys, certificate fingerprint checks, end-to-end encryption (key exchange, rotation, safety codes), handling of deep links and invite links.
- Privilege escalation: a regular member gaining moderator / admin capabilities, publishing media while force-muted or without share permission, bypassing bans, and so on.
- End-to-end encryption: the server (or whoever controls it) being able to decrypt media in rooms with end-to-end encryption enabled, or to add a member without changing the safety code.

Out of scope (known limitations):

- Man-in-the-middle attacks on the **first** connection in self-signed certificate mode (an inherent limitation of TOFU; verify the fingerprint through another channel, or use a proper certificate).
- Metadata visible to the server: who joined which room and when, who is speaking, traffic volume. Chat messages are not end-to-end encrypted.
- Evading UID bans by switching identities, or IP bans by switching IPs (combine with a server password and identity security level).
- Attacks that require physical access to a device or control of the server / client operating system.
- Denial of service through high-volume traffic. Issues where a single connection or IP can cause disproportionate impact are still in scope.

## Security design overview

- **Transport**: the control connection and web pages use TLS. Self-signed certificates are the default: clients remember the certificate's public key fingerprint on first connection (TOFU) and warn if it changes later. A client's authentication signature is bound to the certificate fingerprint it sees, so a man in the middle cannot relay it.
- **Identity**: no accounts. Clients generate Ed25519 identity keys (stored in the keychain / the system's encrypted storage), derived per server, so identities on different servers cannot be linked.
- **Permissions**: all permissions are enforced by the server, and media permissions are synced to the SFU; a tampered client cannot bypass them (covered by end-to-end tests).
- **End-to-end encryption** (optional / required): each person has their own media key, encrypted separately for each member with HPKE and relayed by the server; keys rotate when a member leaves; safety codes let members verify the member list.
- **Server hardening**: the Docker image is distroless, and the service runs as a non-root user (the container starts as root, fixes data directory ownership and drops privileges immediately); rate limits on connections, failed authentication, chat and admin requests; LiveKit's admin interface is not exposed.
