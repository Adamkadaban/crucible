//go:build windows

package exec

import (
	"context"
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"strconv"
	"strings"
	"time"
)

type processExitError int

func (e processExitError) Error() string { return fmt.Sprintf("process exited with code %d", int(e)) }
func (e processExitError) ExitCode() int { return int(e) }

func (r *Runner) runCommand(ctx context.Context, req request, cmd *osexec.Cmd) error {
	principal := req.As
	if principal == "" || principal == "service" {
		return cmd.Run()
	}
	if !r.hasCreds {
		return errors.New("execution credentials are not configured")
	}
	cred := r.credentials.Standard
	if principal == "admin" {
		cred = r.credentials.Admin
	}
	if cred.Username == "" || cred.Password == "" {
		return fmt.Errorf("%s execution credentials are incomplete", principal)
	}
	return runWithScheduledTask(ctx, req, cmd, cred, r.execDir)
}

func runWithScheduledTask(ctx context.Context, req request, cmd *osexec.Cmd, cred accountCredential, execDir string) error {
	baseDir := execDir
	if baseDir == "" {
		baseDir = os.TempDir()
	}
	_ = os.MkdirAll(baseDir, 0o700)
	stdoutPath := tempOutputPath(baseDir, "stdout")
	stderrPath := tempOutputPath(baseDir, "stderr")
	codePath := tempOutputPath(baseDir, "code")
	scriptPath := tempOutputPath(baseDir, "cmd") + ".cmd"
	defer os.Remove(stdoutPath)
	defer os.Remove(stderrPath)
	defer os.Remove(codePath)
	defer os.Remove(scriptPath)
	taskName := `\Crucible\Exec-` + strconv.FormatInt(time.Now().UnixNano(), 36)
	defer runTool(ctx, "schtasks.exe", "/Delete", "/TN", taskName, "/F")
	if err := os.WriteFile(scriptPath, []byte(buildCmdScript(req, cmd.Dir, stdoutPath, stderrPath, codePath)), 0o600); err != nil {
		return err
	}
	runLevel := "HIGHEST"
	startTime := time.Now().Add(1 * time.Minute).Format("15:04")
	tr := `cmd.exe /d /s /c "` + scriptPath + `"`
	if err := runTool(ctx, "schtasks.exe", "/Create", "/TN", taskName, "/SC", "ONCE", "/ST", startTime, "/RU", localUsername(cred.Username), "/RP", cred.Password, "/RL", runLevel, "/TR", tr, "/F"); err != nil {
		return err
	}
	if err := runTool(ctx, "schtasks.exe", "/Run", "/TN", taskName); err != nil {
		return err
	}
	if err := waitForFile(ctx, codePath); err != nil {
		return err
	}
	copyFileToWriter(stdoutPath, cmd.Stdout)
	copyFileToWriter(stderrPath, cmd.Stderr)
	codeBytes, err := os.ReadFile(codePath)
	if err != nil {
		return err
	}
	code, err := strconv.Atoi(strings.TrimSpace(string(codeBytes)))
	if err != nil {
		return err
	}
	if code != 0 {
		return processExitError(code)
	}
	return nil
}

func buildCmdScript(req request, dir, stdoutPath, stderrPath, codePath string) string {
	lines := []string{"@echo off"}
	if dir != "" {
		lines = append(lines, `cd /d `+quoteCmd(dir))
	}
	command := quoteCmd(req.Executable)
	for _, arg := range req.Arguments {
		command += " " + quoteCmdArg(arg)
	}
	lines = append(lines, command+" > "+quoteCmd(stdoutPath)+" 2> "+quoteCmd(stderrPath))
	lines = append(lines, "echo %ERRORLEVEL% > "+quoteCmd(codePath))
	return strings.Join(lines, "\r\n") + "\r\n"
}

func quoteCmd(value string) string { return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"` }

func quoteCmdArg(value string) string {
	if strings.HasPrefix(value, "/") && !strings.ContainsAny(value, " \t\"") {
		return value
	}
	return quoteCmd(value)
}

func localUsername(username string) string {
	if strings.ContainsAny(username, `\@`) {
		return username
	}
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		return username
	}
	return hostname + `\` + username
}

func tempOutputPath(dir, kind string) string {
	f, err := os.CreateTemp(dir, "crucible-exec-"+kind+"-*.tmp")
	if err != nil {
		return dir + `\crucible-exec-` + kind + `.tmp`
	}
	path := f.Name()
	_ = f.Close()
	_ = os.Remove(path)
	return path
}

func copyFileToWriter(path string, writer interface{}) {
	w, ok := writer.(interface{ Write([]byte) (int, error) })
	if !ok || w == nil {
		return
	}
	data, err := os.ReadFile(path)
	if err == nil && len(data) > 0 {
		_, _ = w.Write(data)
	}
}

func waitForFile(ctx context.Context, path string) error {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := os.Stat(path); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func runTool(ctx context.Context, name string, args ...string) error {
	cmd := osexec.CommandContext(ctx, name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s failed: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}
