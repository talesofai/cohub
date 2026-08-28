//go:build !linux && !darwin

package rpc

import "os"

// fileCtimeMs has no portable implementation on this platform; callers omit
// ctimeMs from responses when the second return value is false.
func fileCtimeMs(info os.FileInfo) (int64, bool) {
	return 0, false
}
