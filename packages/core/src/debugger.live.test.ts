import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { DebuggerSessionManager, GuestAgentClient } from "./index.js";

const baseUrl = process.env.CRUCIBLE_GUEST_BASE_URL;
const caPath = process.env.CRUCIBLE_GUEST_CA_PATH;
const certPath = process.env.CRUCIBLE_GUEST_CERT_PATH;
const keyPath = process.env.CRUCIBLE_GUEST_KEY_PATH;

const liveConfigured =
  baseUrl !== undefined && caPath !== undefined && certPath !== undefined && keyPath !== undefined;

describe.runIf(liveConfigured)(
  "DebuggerSessionManager against the live guest agent (env-gated)",
  () => {
    it("opens an attach session against a benign Windows process and runs `lm`", async () => {
      const fs = await import("node:fs/promises");
      const [ca, cert, key] = await Promise.all([
        fs.readFile(caPath!, "utf8"),
        fs.readFile(certPath!, "utf8"),
        fs.readFile(keyPath!, "utf8"),
      ]);
      const guest = new GuestAgentClient({
        baseUrl: baseUrl!,
        caPem: ca,
        clientCertificatePem: cert,
        clientPrivateKeyPem: key,
        timeoutMs: 60_000,
      });

      // 1) Make sure we have a target — spawn a fresh notepad.exe via the
      //    agent's /exec endpoint. We can't easily get the pid back from
      //    a fire-and-forget process, so grab the latest notepad pid by
      //    asking PowerShell. This keeps the test hermetic to whatever
      //    state the guest is already in.
      const pidLookup = await guest.exec({
        executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        arguments: [
          "-NoProfile",
          "-Command",
          "$p = Start-Process -FilePath 'C:\\Windows\\System32\\notepad.exe' -PassThru -WindowStyle Hidden; Start-Sleep -Seconds 1; $p.Id",
        ],
        timeoutMs: 30_000,
      });
      expect(pidLookup.exitCode).toBe(0);
      const pid = parseInt(
        Buffer.from(pidLookup.stdoutBase64 ?? "", "base64")
          .toString()
          .trim(),
        10,
      );
      expect(Number.isFinite(pid)).toBe(true);

      try {
        const mgr = new DebuggerSessionManager({
          run: async (args) => {
            const result = await guest.exec({
              executable: "cdb.exe",
              arguments: [...args],
              timeoutMs: 120_000,
            });
            return {
              stdoutBase64: result.stdoutBase64 ?? "",
              stderrBase64: result.stderrBase64 ?? "",
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              truncated: result.truncated,
              durationMs: result.durationMs,
            };
          },
        });
        const session = mgr.open({ mode: "attach", pid });
        const cmd = await mgr.command(session.id, ["lm"]);
        // exitCode 1 is acceptable from cdb when symbols are missing — what
        // we care about is that we got some output from cdb's `lm` listing
        // the target's loaded modules.
        const stdout = Buffer.from(cmd.stdoutBase64, "base64").toString();
        const stderr = Buffer.from(cmd.stderrBase64 ?? "", "base64").toString();
        const missingCdb =
          cmd.exitCode === -1 ||
          stdout.toLowerCase().includes("is not recognized") ||
          stderr.toLowerCase().includes("is not recognized") ||
          stderr.toLowerCase().includes("cannot find") ||
          stderr.toLowerCase().includes("not found");
        if (missingCdb) {
          console.warn(
            "cdb.exe was not on PATH inside the guest; mark this as the soft-skipped real-VM debugger case",
          );
          return;
        }
        expect(stdout.toLowerCase()).toContain("notepad");
      } finally {
        // Best-effort cleanup of the spawned notepad.
        await guest
          .exec({
            executable: "C:\\Windows\\System32\\taskkill.exe",
            arguments: ["/F", "/PID", String(pid)],
            timeoutMs: 10_000,
          })
          .catch(() => undefined);
        await guest.close();
      }
    });
  },
);
