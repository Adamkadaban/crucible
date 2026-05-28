//go:build !windows

package main

// maybeRunAsService is the non-Windows shim — there's no SCM to integrate with.
func maybeRunAsService() bool { return false }
