package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/shan-mx/amita/apps/companion/internal/protocol"
)

func transferExecute(t *testing.T, e *Executor, method string, params map[string]any, input io.Reader, output io.Writer) (any, *protocol.ResultError) {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	return e.Transfer(context.Background(), method, raw, input, output)
}

func TestImportPublishesOnlyCompleteNewFile(t *testing.T) {
	root := t.TempDir()
	e := New(root, root)
	defer e.Close()
	path := filepath.Join(root, "attachment.bin")
	body := bytes.Repeat([]byte{0, 0xff, 1}, 50000)
	params := map[string]any{"path": path}
	if _, failure := transferExecute(t, e, "importFile", params, bytes.NewReader(body), nil); failure != nil {
		t.Fatal(failure)
	}
	if _, failure := transferExecute(t, e, "importFile", params, bytes.NewReader([]byte("replacement")), nil); failure == nil {
		t.Fatal("overwrote existing file")
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, body) {
		t.Fatal("published bytes differ")
	}
	failed := filepath.Join(root, "failed.bin")
	if _, failure := transferExecute(t, e, "importFile", map[string]any{"path": failed}, interruptedFile{}, nil); failure == nil {
		t.Fatal("interrupted import succeeded")
	}
	if _, err := os.Stat(failed); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("partial file visible")
	}
	stages, _ := filepath.Glob(filepath.Join(root, ".amita-import-*"))
	if len(stages) != 0 {
		t.Fatal("temporary files leaked")
	}
}

type interruptedFile struct{}

func (interruptedFile) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
