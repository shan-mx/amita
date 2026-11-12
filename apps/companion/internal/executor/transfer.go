package executor

import (
	"context"
	"encoding/json"
	"io"

	"github.com/shan-mx/amita/apps/companion/internal/protocol"
)

// Transfer performs file I/O without creating a tool execution for each content frame.
func (e *Executor) Transfer(ctx context.Context, method string, raw json.RawMessage, input io.Reader, output io.Writer) (any, *protocol.ResultError) {
	var params map[string]any
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, fail("invalid", "invalid transfer parameters", "")
	}
	path, failure := e.resolveFilesystemPath(stringArg(params, "path"), stringArg(params, "cwd"))
	if failure != nil {
		return nil, failure
	}
	switch method {
	case "inspectExport", "exportFile":
		return e.exportBinary(ctx, method, path, params, output)
	case "importFile":
		return e.importFile(ctx, path, input)
	default:
		return nil, fail("invalid", "unknown file transfer method", path)
	}
}
