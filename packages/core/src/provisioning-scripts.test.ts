import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

function readProvisionScript(name: string): string {
  return readFileSync(path.join(repositoryRoot, "guest/provision", name), "utf8");
}

describe("WinDbg provisioning scripts", () => {
  it("prefers winget for WinDbg installation", () => {
    const script = readProvisionScript("install-windbg.ps1");

    expect(script).toContain("Install-WithWinget");
    expect(script).toContain('"Microsoft.WinDbg"');
    expect(script).toContain('"--accept-package-agreements"');
    expect(script).toContain('"--accept-source-agreements"');
    expect(script).toContain('"--disable-interactivity"');
  });

  it("falls back to SDK Debugging Tools when winget is unavailable", () => {
    const script = readProvisionScript("install-windbg.ps1");

    expect(script).toContain("Install-WithSdkDebuggingTools");
    expect(script).toContain("linkid=2361308");
    expect(script).toContain("OptionId.WindowsDesktopDebuggers");
    expect(script).toContain("Invoke-WebRequest");
    expect(script).toContain("winsdksetup.exe");
    expect(script).toContain("winsdk-install.log");
    expect(script).toContain("Test-DebuggerToolingPresent");
  });

  it("configures the machine symbol path and debugger readiness checks", () => {
    const installScript = readProvisionScript("install-windbg.ps1");
    const detectionScript = readProvisionScript("test-windbg.ps1");

    for (const script of [installScript, detectionScript]) {
      expect(script).toContain("cdb.exe");
      expect(script).toContain("windbg.exe");
      expect(script).toContain("WinDbgX.exe");
      expect(script).toContain("kd.exe");
      expect(script).toContain("kdnet.exe");
      expect(script).toContain("gflags.exe");
      expect(script).toContain("_NT_SYMBOL_PATH");
      expect(script).toContain("_NT_ALT_SYMBOL_PATH");
      expect(script).toContain("https://msdl.microsoft.com/download/symbols");
      expect(script).toContain("ConvertTo-Json -Compress");
    }

    expect(installScript).toContain("SetEnvironmentVariable");
    expect(installScript).toContain("symbolCacheWritable");
    expect(installScript).toContain("debugger tooling is still incomplete after winget");
    expect(detectionScript).toContain("healthy =");
  });

  it("uses bounded debugger executable searches", () => {
    const installScript = readProvisionScript("install-windbg.ps1");
    const detectionScript = readProvisionScript("test-windbg.ps1");

    for (const script of [installScript, detectionScript]) {
      expect(script).toContain('Filter "Microsoft.WinDbg_*"');
      expect(script).toContain("Join-Path");
      expect(script).not.toContain("-Recurse");
    }
  });

  it("supports dry-run coverage without a Windows VM", () => {
    const script = readProvisionScript("install-windbg.ps1");

    expect(script).toContain("[switch]$DryRun");
    expect(script).toContain(
      "dry-run: readiness check would verify cdb.exe, windbg.exe, and symbol path",
    );
  });

  it("exposes -AllowSkipOnNetworkFailure and exits 75 with a structured payload on installer failure", () => {
    const script = readProvisionScript("install-windbg.ps1");

    expect(script).toContain("[bool]$AllowSkipOnNetworkFailure = $true");
    expect(script).toContain("skipped = $true");
    expect(script).toContain("exit 75");
  });

  it("installs or reports dynamic analysis tools without static-analysis suites", () => {
    const script = readProvisionScript("install-analysis-tools.ps1");

    expect(script).toContain("SysinternalsSuite.zip");
    expect(script).toContain("handle64.exe");
    expect(script).toContain("strings64.exe");
    expect(script).toContain("tcpvcon64.exe");
    expect(script).toContain("procdump64.exe");
    expect(script).toContain("sigcheck64.exe");
    expect(script).toContain("x64dbg.x64dbg");
    expect(script).not.toContain("Ghidra");
    expect(script).not.toContain("cutter.exe");
  });
});
