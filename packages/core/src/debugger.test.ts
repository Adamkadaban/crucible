import { describe, expect, it } from "vitest";

import { DebuggerSessionManager, type RunResult } from "./debugger.js";

function fakeRun(stdout: string, exitCode = 0): RunResult {
  const enc = (s: string) => Buffer.from(s).toString("base64");
  return {
    stdoutBase64: enc(stdout),
    stderrBase64: "",
    exitCode,
    timedOut: false,
    truncated: false,
    durationMs: 1,
  };
}

describe("DebuggerSessionManager", () => {
  it("opens a launch session and assigns a stable id", () => {
    let i = 0;
    const mgr = new DebuggerSessionManager({
      run: () => Promise.resolve(fakeRun("noop")),
      idFactory: () => `id-${(i += 1)}`,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const session = mgr.open({
      mode: "launch",
      executable: "C:\\Windows\\System32\\notepad.exe",
    });
    expect(session.id).toBe("id-1");
    expect(session.transcript).toEqual([]);
    expect(mgr.list()).toHaveLength(1);
  });

  it("builds cdb args for a launch session with symbols and commands", async () => {
    let captured: readonly string[] | undefined;
    const mgr = new DebuggerSessionManager({
      run: (args) => {
        captured = args;
        return Promise.resolve(fakeRun("0:000> "));
      },
    });
    const session = mgr.open({
      mode: "launch",
      executable: "C:\\target.exe",
      arguments: ["--flag"],
      symbolPath: "srv*C:\\Symbols*https://msdl.microsoft.com/download/symbols",
    });
    await mgr.command(session.id, ["!analyze -v", "k"]);
    expect(captured).toEqual([
      "-c",
      "!analyze -v; k; q",
      "-y",
      "srv*C:\\Symbols*https://msdl.microsoft.com/download/symbols",
      "C:\\target.exe",
      "--flag",
    ]);
  });

  it("builds cdb args for an attach session", async () => {
    let captured: readonly string[] | undefined;
    const mgr = new DebuggerSessionManager({
      run: (args) => {
        captured = args;
        return Promise.resolve(fakeRun(""));
      },
    });
    const session = mgr.open({ mode: "attach", pid: 4321 });
    await mgr.command(session.id, ["~*k"]);
    expect(captured).toEqual(["-c", "~*k; q", "-p", "4321"]);
  });

  it("records architecture-specific CDB path on sessions", () => {
    const mgr = new DebuggerSessionManager({
      run: () => Promise.resolve(fakeRun("")),
      cdbExecutableForArch: (arch) => `C:\\Debuggers\\${arch}\\cdb.exe`,
    });
    const x86 = mgr.open({ mode: "attach", pid: 1, arch: "x86" });
    const x64 = mgr.open({ mode: "attach", pid: 2, arch: "x64" });

    expect(x86.cdbExecutable).toBe("C:\\Debuggers\\x86\\cdb.exe");
    expect(x64.cdbExecutable).toBe("C:\\Debuggers\\x64\\cdb.exe");
  });

  it("records every command in the session transcript", async () => {
    const mgr = new DebuggerSessionManager({
      run: () => Promise.resolve(fakeRun("hi")),
    });
    const session = mgr.open({ mode: "attach", pid: 1 });
    await mgr.command(session.id, ["lm"]);
    await mgr.command(session.id, ["~"]);
    const fresh = mgr.get(session.id);
    expect(fresh.transcript).toHaveLength(2);
    expect(fresh.transcript[0]?.command).toBe("lm");
    expect(fresh.transcript[1]?.command).toBe("~");
  });

  it("dump() shells out to .dump /ma <path> by default", async () => {
    let captured: readonly string[] | undefined;
    const mgr = new DebuggerSessionManager({
      run: (args) => {
        captured = args;
        return Promise.resolve(fakeRun("Creating dump"));
      },
    });
    const session = mgr.open({ mode: "attach", pid: 100 });
    await mgr.dump(session.id, {
      outputGuestPath: "C:\\ProgramData\\Crucible\\dump.dmp",
    });
    expect(captured?.[1]).toBe(".dump /ma C:\\ProgramData\\Crucible\\dump.dmp; q");
  });

  it("dump() with minidump:true omits /ma", async () => {
    let captured: readonly string[] | undefined;
    const mgr = new DebuggerSessionManager({
      run: (args) => {
        captured = args;
        return Promise.resolve(fakeRun("Creating dump"));
      },
    });
    const session = mgr.open({ mode: "attach", pid: 1 });
    await mgr.dump(session.id, {
      outputGuestPath: "C:\\mini.dmp",
      minidump: true,
    });
    expect(captured?.[1]).toBe(".dump C:\\mini.dmp; q");
  });

  it("rejects unknown sessions", () => {
    const mgr = new DebuggerSessionManager({
      run: () => Promise.resolve(fakeRun("")),
    });
    expect(() => mgr.get("missing")).toThrow(/not found/i);
  });

  it("close() removes the session", () => {
    const mgr = new DebuggerSessionManager({
      run: () => Promise.resolve(fakeRun("")),
    });
    const s = mgr.open({ mode: "attach", pid: 1 });
    mgr.close(s.id);
    expect(() => mgr.get(s.id)).toThrow();
  });

  it("rejects empty / oversize command sequences", async () => {
    const mgr = new DebuggerSessionManager({
      run: () => Promise.resolve(fakeRun("")),
    });
    const s = mgr.open({ mode: "attach", pid: 1 });
    await expect(mgr.command(s.id, [])).rejects.toThrow(/at least one command/);
    const big = "x".repeat(5_000);
    await expect(mgr.command(s.id, [big])).rejects.toThrow(/exceeds/);
  });
});
