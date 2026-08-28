//go:build linux

package rpc

import (
	"os"
	"syscall"
)

// fileCtimeMs reports the inode change time (ctime) in milliseconds.
func fileCtimeMs(info os.FileInfo) (int64, bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return stat.Ctim.Sec*1000 + stat.Ctim.Nsec/1_000_000, true
}
