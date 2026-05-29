//go:build !windows

package exec

import (
	"context"
	"errors"
	osexec "os/exec"
)

func (r *Runner) runCommand(ctx context.Context, req request, cmd *osexec.Cmd) error {
	if req.As == "standard" || req.As == "admin" {
		return errors.New("standard/admin execution is only supported on Windows")
	}
	return cmd.Run()
}
