package executor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"

	"github.com/shan-mx/amita/apps/companion/internal/protocol"
)

const binaryImportMaxBytes = 20 << 20

type binaryImportReceipt struct {
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Version string `json:"version"`
}

// Import publishes a complete file atomically without overwriting an existing file.
func (e *Executor) importFile(ctx context.Context, path string, input io.Reader) (any, *protocol.ResultError) {
	if input == nil {
		return nil, fail("invalid", "an import stream is required", path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, mapError(err, path)
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".amita-import-*")
	if err != nil {
		return nil, mapError(err, path)
	}
	defer os.Remove(file.Name())
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(contextReader{ctx: ctx, reader: input}, binaryImportMaxBytes+1))
	if err != nil {
		return nil, mapError(err, path)
	}
	if size > binaryImportMaxBytes {
		return nil, fail("too_large", "the import exceeds the transfer limit", path)
	}
	if failure := checkContext(ctx, path); failure != nil {
		return nil, failure
	}
	if err := os.Link(file.Name(), path); err != nil {
		return nil, mapError(err, path)
	}
	return binaryImportReceipt{Path: path, Size: size, Version: "sha256:" + hex.EncodeToString(hash.Sum(nil))}, nil
}
