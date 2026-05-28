#!/usr/bin/env python3
"""Drive every guest provisioning stage against the live VM using the same
file-stage + -File pattern QgaProvisioningExecutor uses now."""
import socket, json, time, base64, os, sys

SOCK = "artifacts/qga.sock"

def conn():
    s = socket.socket(socket.AF_UNIX)
    s.connect(SOCK)
    s.settimeout(120)
    return s

def call(s, cmd):
    s.sendall(json.dumps(cmd).encode() + b"\n")
    data = b""
    try:
        while True:
            chunk = s.recv(65536)
            if not chunk: break
            data += chunk
            if b"\n" in data: break
    except socket.timeout: pass
    for line in data.splitlines():
        line = line.lstrip(b"\xff")
        if line.strip():
            try: return json.loads(line)
            except Exception: return {"raw": line.decode(errors="replace")}
    return None

def write_to_guest(script_path, guest_path):
    body = open(script_path, "rb").read()
    s = conn()
    r = call(s, {"execute":"guest-file-open","arguments":{"path":guest_path,"mode":"wb"}})
    handle = r["return"]
    # chunk 32KB
    for i in range(0, len(body), 32*1024):
        chunk = body[i:i+32*1024]
        call(s, {"execute":"guest-file-write","arguments":{"handle":handle,"buf-b64":base64.b64encode(chunk).decode()}})
    call(s, {"execute":"guest-file-close","arguments":{"handle":handle}})
    s.close()

def mkdir(guest_path):
    s = conn()
    # Use PowerShell New-Item for reliable directory creation with spaces.
    cmd = f"New-Item -ItemType Directory -Force -Path '{guest_path}' | Out-Null"
    r = call(s, {"execute":"guest-exec","arguments":{
        "path":"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "arg":["-NoProfile","-Command", cmd], "capture-output":True}})
    if "return" in r:
        pid = r["return"]["pid"]
        for _ in range(30):
            time.sleep(0.5)
            st = call(s, {"execute":"guest-exec-status","arguments":{"pid":pid}})
            if st.get("return",{}).get("exited"):
                ret = st["return"]
                if ret["exitcode"] != 0:
                    err = base64.b64decode(ret.get("err-data","")).decode(errors="replace")
                    print(f"  mkdir {guest_path} failed: exit={ret['exitcode']} err={err[:200]}")
                break
    else:
        print(f"  mkdir start err: {r}")
    s.close()

def run_file(label, guest_path, args=None, env=None, timeout_s=600):
    print(f"\n===== {label}")
    s = conn()
    # Use absolute path to powershell.exe so qemu-ga doesn't need to search PATH.
    powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    arg_list = ["-NoProfile","-ExecutionPolicy","Bypass","-File", guest_path]
    if args:
        arg_list += args
    exec_args = {"path":powershell,"arg":arg_list,"capture-output":True}
    if env:
        # qemu-ga replaces the whole env when 'env' is set. Include the
        # essentials so the script can still find Windows DLLs / temp dirs.
        merged = {
            "PATH": "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
            "SystemRoot": "C:\\Windows",
            "windir": "C:\\Windows",
            "TEMP": "C:\\Windows\\Temp",
            "TMP": "C:\\Windows\\Temp",
            **env,
        }
        exec_args["env"] = [f"{k}={v}" for k, v in merged.items()]
    r = call(s, {"execute":"guest-exec","arguments":exec_args})
    if not r or "return" not in r:
        print(f"  start err: {r}")
        return None
    pid = r["return"]["pid"]
    print(f"  pid={pid}")
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        time.sleep(2)
        st = call(s, {"execute":"guest-exec-status","arguments":{"pid":pid}})
        ret = st.get("return")
        if ret and ret.get("exited"):
            out = base64.b64decode(ret.get("out-data","")).decode(errors="replace")
            err = base64.b64decode(ret.get("err-data","")).decode(errors="replace")
            print(f"  exit={ret['exitcode']}")
            if out.strip():
                clean = out.strip()
                print(f"  STDOUT (last 1500):\n{clean[-1500:]}")
            if err.strip():
                clean = err.strip()
                # filter CLIXML progress noise
                if "CLIXML" not in clean or len(clean) < 200:
                    print(f"  STDERR (last 800):\n{clean[-800:]}")
            s.close()
            return ret["exitcode"]
    print("  TIMEOUT")
    s.close()
    return None

# Read secrets
adm = json.load(open("artifacts/secrets/crucible-win11/windows/admin-user.json"))
std = json.load(open("artifacts/secrets/crucible-win11/windows/standard-user.json"))

print("staging dir...")
mkdir("C:\\ProgramData\\Crucible\\stages")
mkdir("C:\\ProgramData\\Crucible\\staging")
mkdir("C:\\ProgramData\\Crucible\\Agent")
mkdir("C:\\ProgramData\\Crucible\\Agent\\certs")
mkdir("C:\\Program Files\\Crucible")

print("staging mTLS material + agent binary...")
mtls_dir = "artifacts/secrets/crucible-win11/mtls"
for src, dst in [
    (f"{mtls_dir}/ca.cert.pem",           "C:\\ProgramData\\Crucible\\Agent\\certs\\ca.cert.pem"),
    (f"{mtls_dir}/guest-server.cert.pem", "C:\\ProgramData\\Crucible\\Agent\\certs\\guest-server.cert.pem"),
    (f"{mtls_dir}/guest-server.key.pem",  "C:\\ProgramData\\Crucible\\Agent\\certs\\guest-server.key.pem"),
    ("/tmp/crucible-agent.exe",           "C:\\Program Files\\Crucible\\crucible-agent.exe"),
]:
    if not os.path.exists(src):
        print(f"  !! missing source: {src}"); sys.exit(1)
    print(f"  upload {src} -> {dst}")
    write_to_guest(src, dst)

stages = [
    ("probe-qga",          "guest/provision/probe-qga.ps1",        [],                               None),
    ("configure-policy",   "guest/provision/configure-policy.ps1", [],                               None),
    ("create-local-accounts","guest/provision/create-local-accounts.ps1", [],                         {"CRUCIBLE_ADMIN_PASSWORD":adm["password"],"CRUCIBLE_STANDARD_PASSWORD":std["password"]}),
    ("install-windbg",     "guest/provision/install-windbg.ps1",   ["-AllowSkipOnNetworkFailure"],   None),
    ("install-agent",      "guest/provision/install-agent.ps1",
        ["-ServiceName","CrucibleGuestAgent","-ControlAddress","192.0.2.2","-HostOnlySourceAddress","192.0.2.1","-ControlPort","8443"],
        {"CRUCIBLE_ADMIN_PASSWORD":adm["password"],"CRUCIBLE_STANDARD_PASSWORD":std["password"]}),
    ("test-health",        "guest/provision/test-health.ps1",      ["-AllowMissingWinDbg"],          None),
    ("prepare-snapshot",   "guest/provision/prepare-snapshot.ps1", ["-SnapshotName","clean-base"],   None),
]

for label, host_path, args, env in stages:
    guest = f"C:\\ProgramData\\Crucible\\stages\\{os.path.basename(host_path)}"
    print(f"staging {host_path} -> {guest}")
    write_to_guest(host_path, guest)
    rc = run_file(label, guest, args=args, env=env, timeout_s=600)
    if rc not in (0, 75):
        print(f"\n!! stage {label} failed with exit code {rc}")
        sys.exit(1)
print("\n=== all stages complete ===")
