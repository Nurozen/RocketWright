# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's private
vulnerability reporting:
[Report a vulnerability](https://github.com/Nurozen/RocketWright/security/advisories/new)
(the repository's **Security** tab, then **Report a vulnerability**). Do not
open a public issue, discussion, or pull request for a vulnerability.

Include the affected component, the version or commit, your platform, and
steps to reproduce. Do not send passwords, API keys, provider credentials, or
private project files; a minimal project that reproduces the problem is best.

We will acknowledge the report, keep you informed while we investigate, and
credit you in the advisory unless you prefer otherwise.

## Supported versions

RocketWright is pre-release. Only the latest commit on `main` receives
security fixes.

## Scope

In scope: the `rocketwright`/`rw` CLI and MCP server, the desktop app (its
app server, RPC token check, sidecar socket, and `rocketwright://` link
handling), project file parsing and import (`rocketwright.toml`,
`rocket.rw.toml`, `.ork`, motor files), and anything that lets a project or an
agent tool write outside its project or run commands without approval.

Problems in the embedded agent pane itself belong to
[Lecturn](https://github.com/Nurozen/lecturn); report them there, following
its security policy. Problems in a provider CLI (for example Claude Code or
Codex) belong to that provider.
