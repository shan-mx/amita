package executor

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"syscall"

	"github.com/shan-mx/amita/apps/companion/internal/protocol"
)

const binaryExportMaxBytes = 20 << 20
const mediaSniffBytes = 512

type exportInfo struct {
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	MediaType string `json:"mediaType"`
}

func (e *Executor) exportBinary(ctx context.Context, method, path string, params map[string]any, destination io.Writer) (any, *protocol.ResultError) {
	maxBytes, valid := int64Arg(params["maxBytes"])
	if !valid || maxBytes < 1 || maxBytes > binaryExportMaxBytes {
		return nil, fail("invalid", "invalid export size limit", path)
	}
	source, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, mapError(err, path)
	}
	defer source.Close()
	stat, err := source.Stat()
	if err != nil {
		return nil, mapError(err, path)
	}
	if !stat.Mode().IsRegular() {
		return nil, fail("invalid", "export requires a regular file", path)
	}

	if stat.Size() > maxBytes {
		return nil, fail("too_large", "the source file exceeds the transfer limit", path)
	}
	reader := bufio.NewReader(contextReader{ctx: ctx, reader: source})
	prefix, _ := reader.Peek(mediaSniffBytes)
	mediaType := http.DetectContentType(prefix)
	if method == "inspectExport" {
		return exportInfo{Name: filepath.Base(path), Size: stat.Size(), MediaType: mediaType}, nil
	}
	copied, err := io.Copy(destination, io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return nil, mapError(err, path)
	}
	if copied > maxBytes {
		return nil, fail("too_large", "the source file exceeds the transfer limit", path)
	}
	return nil, checkContext(ctx, path)
}
