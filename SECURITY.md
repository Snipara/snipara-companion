# Security Policy

## Supported Versions

Security fixes target the latest published `snipara-companion` version on npm.

Check the current version with:

```bash
npm view snipara-companion version
```

## Reporting A Vulnerability

Report suspected vulnerabilities through GitHub private vulnerability reporting
when available, or open a minimal issue that does not include secrets, tokens,
private keys, private repository output, or customer data.

For local `impact` issues, include only redacted command output. `--source local`
is designed to keep code analysis on your machine; do not paste private source
files into public issues.

## Scope

This repository covers the open-source local CLI package. Hosted Snipara account
security, team memory, cloud graph behavior, and dashboard security should be
reported through Snipara's hosted support path rather than this repository.

