package client

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"sync"

	"github.com/shan-mx/amita/apps/companion/internal/executor"
	"github.com/shan-mx/amita/apps/companion/internal/protocol"
)

type incomingFile struct {
	writer *io.PipeWriter
	cancel context.CancelFunc
}

type fileFrame struct {
	Type    string           `json:"type"`
	ID      string           `json:"id"`
	Content string           `json:"content,omitempty"`
	Result  *protocol.Result `json:"result,omitempty"`
}

type fileWriter struct {
	id    string
	write func(any) error
}

func (w fileWriter) Write(bytes []byte) (int, error) {
	written := 0
	for len(bytes) > 0 {
		count := min(len(bytes), protocol.FileChunkBytes)
		if err := w.write(fileFrame{Type: "file_chunk", ID: w.id, Content: base64.StdEncoding.EncodeToString(bytes[:count])}); err != nil {
			return written, err
		}
		written += count
		bytes = bytes[count:]
	}
	return written, nil
}

// File content is connection-scoped. Pi owns the publication intent and committed result.
type fileTransfers struct {
	mu     sync.Mutex
	active map[string]*incomingFile
}

func (t *fileTransfers) close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for id, transfer := range t.active {
		transfer.cancel()
		if transfer.writer != nil {
			_ = transfer.writer.CloseWithError(context.Canceled)
		}
		delete(t.active, id)
	}
}

func (t *fileTransfers) start(ctx context.Context, frame protocol.Frame, ex *executor.Executor, write func(any) error) {
	ctx, cancel := context.WithTimeout(ctx, protocol.FileTransferTimeout)
	transfer := &incomingFile{cancel: cancel}
	var reader *io.PipeReader
	if frame.Method == "importFile" {
		reader, transfer.writer = io.Pipe()
	}
	t.mu.Lock()
	if previous := t.active[frame.ID]; previous != nil {
		t.mu.Unlock()
		cancel()
		if reader != nil {
			_ = reader.Close()
			_ = transfer.writer.Close()
		}
		return
	}
	t.active[frame.ID] = transfer
	t.mu.Unlock()
	go func() {
		defer cancel()
		defer func() { t.mu.Lock(); delete(t.active, frame.ID); t.mu.Unlock() }()
		if reader != nil {
			stop := context.AfterFunc(ctx, func() { _ = reader.CloseWithError(ctx.Err()) })
			defer stop()
			defer reader.Close()
		}
		value, failure := ex.Transfer(ctx, frame.Method, frame.Params, reader, fileWriter{id: frame.ID, write: write})
		_ = write(fileFrame{Type: "file_result", ID: frame.ID, Result: &protocol.Result{OK: failure == nil, Value: value, Error: failure}})
	}()
}

func (t *fileTransfers) feed(frame protocol.Frame) {
	t.mu.Lock()
	transfer := t.active[frame.ID]
	t.mu.Unlock()
	if transfer == nil {
		return
	}
	if frame.Type == "file_cancel" {
		transfer.cancel()
		if transfer.writer != nil {
			_ = transfer.writer.CloseWithError(context.Canceled)
		}
		return
	}
	if transfer.writer == nil {
		return
	}
	if frame.Type == "file_end" {
		_ = transfer.writer.Close()
		return
	}
	data, err := base64.StdEncoding.DecodeString(frame.Content)
	if err != nil || len(data) > protocol.FileChunkBytes {
		_ = transfer.writer.CloseWithError(fmt.Errorf("invalid file content"))
		return
	}
	_, _ = transfer.writer.Write(data)
}
