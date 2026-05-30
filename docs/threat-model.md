# Threat Model

Crucible provisions Windows VMs for malware analysis and vulnerability debugging. The guest is
therefore untrusted after any sample, exploit proof of concept, or unknown binary runs. The safe
default is containment, repeatability, and narrow host exposure rather than convenience.

## Protected Assets

- The Linux host, including the operator's home directory, SSH keys, browser profiles, shell
  history, package credentials, and Git remotes.
- Crucible secret material under `artifacts.secretsDirectory`, including future guest service mTLS
  keys and generated Windows account credentials.
- VM artifacts under `artifacts.directory` and `artifacts.snapshotsDirectory`, including disks,
  snapshots, logs, crash dumps, debugger transcripts, and packet captures.
- Source files and repository history. Malware samples, VM images, snapshots, dumps, pcaps, symbol
  caches, and generated credentials must not be committed.

## Trust Boundaries

- The guest operating system is untrusted. Treat every guest command result, file path, archive,
  debugger output, and downloaded artifact as attacker-controlled.
- QEMU/KVM is a containment boundary, not a perfect sandbox. A guest-to-host hypervisor escape is in
  scope as an assumed catastrophic failure mode and is mitigated by reducing exposed host resources.
- The host MCP server and CLI are trusted orchestration components but must not expose broad host
  file access to the guest.
- QMP and QGA sockets are local host control surfaces. They should live under project-owned artifact
  paths and should not be exposed to other users or networks.
- The future guest service is a host-only control surface authenticated with mTLS. It must not
  become a general network listener or an unauthenticated command channel.

## Malware Escape Assumptions

- Assume malware can obtain administrator privileges inside the Windows guest.
- Assume malware can inspect guest memory and disk state, including any credentials or samples
  staged inside the VM.
- Assume malware can attack QEMU devices, virtio drivers, QGA, the guest service, and any reachable
  network service.
- Do not rely on Windows Defender, code integrity, or test-signing policy as containment. Analysis
  VMs may intentionally weaken guest protections for reverse engineering, so containment must come
  from VM, network, credential, and artifact boundaries.

## Host File Exposure

- Host shared folders are disabled by default and are not part of the safe malware-analysis posture.
- File movement should use audited upload/download tools that stream directly between explicit host
  and guest paths, record hashes, and keep operator-selected sample directories out of the
  repository.
- Do not mount the operator's home directory, repository root, SSH agent socket, package manager
  caches, browser profiles, or cloud credential directories into the guest.
- Keep `artifacts.directory`, `artifacts.snapshotsDirectory`, and sample storage outside directories
  that are automatically synced, indexed, or backed up to shared services.

## Credential Handling

- Generated Windows account passwords, guest service private keys, client certificates, and recovery
  tokens belong under `artifacts.secretsDirectory` with restrictive host file permissions.
- Logs, dry-run output, MCP responses, and artifact manifests must identify credential files by path
  or fingerprint only. They must not echo secret values.
- Credentials used inside a dirty guest should be considered compromised after sample execution.
- Rotate guest service certificates and generated Windows account credentials after suspected
  escape, accidental network exposure, or reuse across analysis projects.

## Snapshot Policy

- Treat clean snapshots as recovery points, not as proof that a sample was contained.
- Restore a known-clean snapshot before executing a sample or exploit proof of concept.
- Restore again after collecting required artifacts so dirty guest state does not leak into later
  investigations.
- Store snapshots as artifacts outside Git. Do not delete snapshots automatically during routine VM
  lifecycle cleanup; destructive cleanup should require an explicit operator action.
- If a sample may have escaped the VM boundary, do not trust snapshots from the affected VM lineage.
  Preserve evidence, rotate credentials, and rebuild from known-good installation media.

## Internet Egress

- `isolated` is the default `network.mode` and is the malware-analysis default. The current network
  contract uses restricted QEMU user networking for the host-control channel only and carries
  `deny-guest-egress` firewall intent, so the guest must not have Internet access by default.
- `nat` is explicit opt-in guest Internet egress through QEMU user networking. Do not use it for
  unknown malware unless the analysis objective requires live egress and the operator accepts the
  risk.
- `capture` is explicit opt-in tap-backed capture. Packet captures are artifacts and must stay out
  of repo-controlled paths.
- Never add extra QEMU network arguments that bypass Crucible's network plan unless the dry-run
  output is reviewed and the risk is intentional.

## Containment Boundaries

- Network rules must be project-owned and VM-scoped. Teardown may remove only matching Crucible
  owner tags and must not flush broad firewall tables or unrelated host interfaces.
- Firewall plans default to dry-run output and project-owned nftables/iptables chains and comments.
  Apply and teardown command models may target only firewall state generated for the same Crucible
  VM owner tag.
- The default control mapping listens on host loopback `127.0.0.1:8443` and forwards to guest
  address `192.0.2.2:8443`; QEMU user networking uses `192.0.2.1/30` as the QEMU-side gateway and
  `192.0.2.2/30` as the guest address.
- Host-only control is allowed; arbitrary guest-to-LAN, guest-to-Internet, and host filesystem
  access are not allowed in the safe default.
- Operator-provided `vm.extraQemuArgs` can weaken containment. Review dry-run QEMU output before
  launching a VM with extra device, filesystem, socket, or network flags.

## Residual Risk

Crucible reduces accidental exposure, but it cannot guarantee containment against hypervisor
escapes, kernel vulnerabilities, malicious media, supply-chain compromise, operator-added QEMU
flags, or host misconfiguration. Run it on a dedicated analysis host when handling real malware.

## Open Updates

- Document guest-service authentication and file staging constraints after Phase 4 contracts land.
- Document operator warnings and safe artifact directory policy as Phase 2 continues.
