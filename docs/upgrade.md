# Upgrade

Crucible has not shipped a tagged release yet, but the host- and guest-side upgrade paths are
designed to keep configuration files, secrets, and snapshots intact across versions.

## Host upgrade

1. `git pull origin main`.
2. `pnpm install --frozen-lockfile` to refresh dependencies.
3. `pnpm build` to compile the TypeScript surfaces.
4. `pnpm check` to verify the tree.

`crucible.config.json` is the only file the operator owns. The schema under
`schemas/config.schema.json` only adds fields; existing config files continue to validate. If
`parseCrucibleConfig` reports a new required field, the error message points at the missing key.

## Guest agent upgrade

1. `bash scripts/package-release.sh` to produce `dist/release/crucible-guest-agent.exe` and the
   release manifest.
2. Upload the binary into the guest staging directory:
   ```sh
   crucible mcp --stdio  # then use guest_upload from your MCP client
   ```
3. Stop the service inside the guest, replace the binary, and start the service again:
   ```sh
   # via guest_exec
   net stop CrucibleGuestAgent
   copy /Y C:\ProgramData\Crucible\staging\crucible-guest-agent.exe ^
       "C:\Program Files\Crucible\crucible-guest-agent.exe"
   net start CrucibleGuestAgent
   ```

The Go binary keeps the same CLI surface across versions; new flags default to safe values so an
upgraded binary tolerates old service-installation configurations. Older binaries refuse new flags
loudly, surfacing as a non-zero service exit code that `vm_status` reports.

## Snapshot compatibility

Snapshots persist under the `snapshots/` directory keyed by VM name. Upgrades never touch them. The
recommended flow is:

1. Restore `clean-base` (or the latest known-good snapshot).
2. Apply the upgrade steps above.
3. Run `crucible guest:health` (or `guest_health` via MCP) to confirm.
4. Take a fresh snapshot (`crucible snapshot:create post-upgrade`).
5. Continue analysis from the new snapshot.

## Schema migrations

When the config schema introduces a backwards-incompatible field (none today), Crucible will ship a
`migrate <old> <new>` subcommand and note the change in `CHANGELOG.md`.
