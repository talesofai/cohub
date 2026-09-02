//go:build !linux && !darwin

package rpc

import "os"

func fileCtimeMs(os.FileInfo) (int64, bool) {
	return 0, false
}
