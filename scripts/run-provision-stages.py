#!/usr/bin/env python3
"""Run each provisioning PowerShell script via QGA against the live VM.

This is a debug-only helper used while iterating on the guest scripts and
the QgaProvisioningExecutor wiring. It currently uses the legacy
-EncodedCommand path; the production executor stages scripts to
C:\\ProgramData\\Crucible\\stages\\<name>.ps1 via guest-file-open /
-write / -close and invokes them with -File. Use scripts/verify-executor-live.mts
when you need the exact production behaviour.
"""
import socket, json, time, base64, os, sys
SOCK = "artifacts/qga.sock"
def call(s, cmd):
    s.sendall(json.dumps(cmd).encode()+b"\n")
    data=b""; s.settimeout(60)
    try:
        while True:
            c=s.recv(65536)
            if not c: break
            data+=c
            if data.count(b"\n"): break
    except socket.timeout: pass
    for line in data.splitlines():
        line=line.lstrip(b"\xff")
        if line.strip():
            try: return json.loads(line)
            except Exception: return line.decode(errors="replace")
    return None
def connect():
    s=socket.socket(socket.AF_UNIX); s.connect(SOCK); s.settimeout(10); return s
def encoded(script_path):
    body = open(script_path, encoding="utf-8").read()
    return base64.b64encode(body.encode("utf-16-le")).decode()
def run_script(label, script_path, args=None, env=None, timeout_s=300):
    print(f"\n===== {label}  ({script_path})")
    if not os.path.exists(script_path):
        print(f"  !! script missing: {script_path}")
        return
    s=connect()
    try:
        arg_list = ["-NoProfile","-ExecutionPolicy","Bypass","-EncodedCommand", encoded(script_path)]
        if args:
            arg_list += args
        env_list = [f"{k}={v}" for k,v in (env or {}).items()]
        exec_args = {"path":"powershell.exe","arg":arg_list,"capture-output":True}
        if env_list:
            exec_args["env"] = env_list
        r = call(s, {"execute":"guest-exec","arguments":exec_args})
        if not r or "return" not in r:
            print("  start err:", r); return
        pid = r["return"]["pid"]
        print(f"  pid={pid}")
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            time.sleep(2)
            st = call(s, {"execute":"guest-exec-status","arguments":{"pid":pid}})
            if st and st.get("return",{}).get("exited"):
                out = base64.b64decode(st["return"].get("out-data","")).decode(errors="replace")
                err = base64.b64decode(st["return"].get("err-data","")).decode(errors="replace")
                print(f"  exit={st['return']['exitcode']}")
                if out.strip(): print(f"  STDOUT (last 1500):\n{out.strip()[-1500:]}")
                if err.strip(): print(f"  STDERR (last 1500):\n{err.strip()[-1500:]}")
                return
        print("  TIMEOUT")
    finally:
        try: s.close()
        except: pass
# Helper to read host-side secrets to inject env vars (matches executor)
def secret(path, key):
    try:
        with open(path) as f: return json.load(f)[key]
    except Exception as e:
        print(f"[warn] secret {path} unreadable: {type(e).__name__}: {e}", file=sys.stderr)
        return None
adm_pw = secret("artifacts/secrets/crucible-win11/windows/admin-user.json","password")
std_pw = secret("artifacts/secrets/crucible-win11/windows/standard-user.json","password")
if adm_pw is None or std_pw is None:
    print("[warn] missing admin/standard secret; create-local-accounts/install-agent will likely fail in-guest", file=sys.stderr)
run_script("probe-qga", "guest/provision/probe-qga.ps1", timeout_s=60)
run_script("configure-policy", "guest/provision/configure-policy.ps1", timeout_s=300)
run_script("install-windbg",  "guest/provision/install-windbg.ps1", timeout_s=600)
run_script("create-local-accounts", "guest/provision/create-local-accounts.ps1",
           env={"CRUCIBLE_STANDARD_PASSWORD": std_pw or "", "CRUCIBLE_ADMIN_PASSWORD": adm_pw or ""}, timeout_s=120)
run_script("install-agent",   "guest/provision/install-agent.ps1",
           env={"CRUCIBLE_STANDARD_PASSWORD": std_pw or "", "CRUCIBLE_ADMIN_PASSWORD": adm_pw or ""}, timeout_s=300)
run_script("test-health",     "guest/provision/test-health.ps1", timeout_s=120)
