# Security policy

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub: go to the [Security tab](https://github.com/benvinegar/opentui-irc/security/advisories/new) and choose **Report a vulnerability**.

Include what you found, how to reproduce it, and the impact you expect. You'll get an acknowledgement as soon as the maintainer sees it. This is a volunteer project, so there is no guaranteed response time.

## Supported versions

opentui-irc is alpha software. Only the latest `main` receives fixes.

## Scope

Of particular interest: anything that lets IRC servers or peers run commands, write files, inject terminal escape sequences, read credentials, or bypass TLS verification, and anything that lets the local control socket exceed its granted permissions.

The intended trust boundaries and known limitations are in [docs/SECURITY.md](docs/SECURITY.md).
