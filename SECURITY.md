# Security Policy

Crucible is a local operator tool for Windows malware-analysis and debugging workflows. It is not a
guaranteed containment boundary.

## Supported Use

- Run Crucible on a dedicated Linux host or workstation that you control.
- Keep the default isolated network mode unless guest egress is intentional.
- Restore `clean-base` before each new sample or proof-of-concept run.
- Store samples, VM disks, dumps, packet captures, symbols, and generated credentials outside Git
  and outside cloud-synced folders.

## Non-Goals

- Crucible does not protect against QEMU/KVM, host-kernel, firmware, or hardware escapes.
- Crucible does not make arbitrary malware safe to run on a shared workstation.
- Crucible does not provide multi-tenant isolation or hosted service security.

## Sensitive Local Files

Treat these as local secrets or sensitive artifacts:

- `crucible.config.json`
- `artifacts/secrets/`
- `artifacts/boot/Autounattend.xml`
- `artifacts/boot/autounattend.iso`
- `artifacts/disks/`
- `snapshots/`
- `artifacts/downloads/`
- memory dumps, crash dumps, pcaps, samples, and symbol caches
- TLS key log files associated with packet captures

These paths are ignored by Git by default. Do not paste their raw contents into public issues or
pull requests.

## Reporting Vulnerabilities

If you find a security issue in Crucible itself, open a private report through GitHub Security
Advisories if available. If private advisories are unavailable, open a minimal public issue that
describes the impact without including exploit samples, private keys, passwords, local paths, or raw
logs.

Good public report style:

- Describe the affected command or component.
- Use placeholders such as `/path/to/windows.iso` and `<vm>`.
- Summarize logs instead of pasting full local state manifests.
- State whether the issue affects host isolation, guest control authentication, artifact handling,
  or operator safety.

## Public Issue Hygiene

When filing normal bugs, avoid including:

- Absolute home-directory paths.
- Raw `artifacts/state/*.json` contents.
- Raw mTLS material, generated account JSON, or autounattend contents.
- Real malware samples or hashes from private investigations.
- Cloud credentials, package tokens, SSH agent paths, or browser profile paths.
