# Security Policy

## Supported Versions

Canvas Notebook uses date-based release versions and publishes container images through GitHub Container Registry.
Security fixes are provided for the currently maintained release channel only.

| Version / Channel | Supported |
| ----------------- | --------- |
| Latest published release and `ghcr.io/canvascoding/canvas-notebook:latest` | :white_check_mark: |
| `main` branch before the next release | Best effort |
| Older release tags and older container images | :x: |
| Forked or modified builds | :x: |

Self-hosted users should update to the latest release as soon as a security fix is available:

```bash
canvas-notebook update
```

If you run a custom deployment, rebuild or redeploy from the latest release after the fix is published.

## Reporting a Vulnerability

Please do not open a public GitHub issue, discussion, or pull request for security vulnerabilities.

Report vulnerabilities privately through GitHub Security Advisories:

https://github.com/canvascoding/canvas-notebook/security/advisories/new

If private vulnerability reporting is unavailable, open a minimal public issue asking for a private security contact. Do not include vulnerability details in that issue.

### What to Include

Please include as much of the following as possible:

- Affected version, release tag, commit, or container image digest
- Deployment type, such as installer, Docker Compose, local development, or custom hosting
- Affected component, such as authentication, file access, terminal, API route, installer, container, integrations, or agent runtime
- Clear reproduction steps
- Expected and actual behavior
- Impact assessment, including what an attacker could read, modify, execute, or bypass
- Proof of concept, logs, screenshots, or request samples when safe to share
- Whether any secrets, API keys, personal data, or workspace files may have been exposed

Please redact tokens, passwords, API keys, session cookies, and personal data before sending a report.

### Response Timeline

We aim to:

- Acknowledge the report within 3 business days
- Confirm whether the issue is accepted, needs more information, or is out of scope after initial triage
- Provide updates at least every 7 days while the report is actively being investigated
- Coordinate disclosure once a fix or mitigation is available

Accepted reports may result in a patch release, updated container image, documentation update, GitHub Security Advisory, and dependency advisory where applicable.

If a report is declined, we will explain the reason, such as unsupported version, missing security impact, duplicate report, or behavior requiring an intentionally insecure custom deployment.

## Scope

Examples of in-scope vulnerabilities include:

- Authentication bypass or session compromise
- Unauthorized access to workspace files, `/data`, SQLite data, or secrets
- Arbitrary file read or write outside intended storage boundaries
- Remote code execution or unintended command execution
- Server-side request forgery with meaningful impact
- Cross-site scripting, cross-site request forgery, or privilege escalation
- Exposure of integration secrets, AI provider API keys, internal API keys, or bootstrap credentials
- Insecure installer, update, container, or CLI behavior that affects default deployments

Examples that are usually out of scope:

- Reports against unsupported releases or old container images without confirming the latest release is affected
- Vulnerabilities in dependencies without an exploitable path in Canvas Notebook
- Denial-of-service reports based only on high traffic volume
- Social engineering or physical attacks
- Self-XSS that requires an administrator to paste untrusted code into their own browser or terminal
- Missing hardening recommendations without a concrete security impact
- Publicly disclosed vulnerabilities before coordinated disclosure

## Safe Harbor

We support good-faith security research. To stay within safe harbor:

- Do not access, modify, delete, or exfiltrate data that does not belong to you
- Do not interrupt service for other users or deployments
- Use test instances, local deployments, or your own data whenever possible
- Stop testing and report promptly if you encounter sensitive data
- Give us a reasonable opportunity to investigate and fix before public disclosure

Reports that follow these guidelines will be handled as coordinated vulnerability disclosure.
