package executor

import (
	"bytes"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestBinaryExportReadsCurrentFile(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "source.bin")
	body := bytes.Repeat([]byte{0, 1, 0xff, 0x80}, 40000)
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	e := New(home, home)
	defer e.Close()
	params := map[string]any{"path": path, "maxBytes": len(body)}
	metadata, failure := transferExecute(t, e, "inspectExport", params, nil, nil)
	if failure != nil {
		t.Fatal(failure)
	}
	inspected, ok := metadata.(exportInfo)
	if !ok || inspected.Size != int64(len(body)) {
		t.Fatalf("wrong export metadata: %+v", metadata)
	}

	var output bytes.Buffer
	if _, failure := transferExecute(t, e, "exportFile", params, nil, &output); failure != nil {
		t.Fatal(failure)
	}
	if !bytes.Equal(output.Bytes(), body) {
		t.Fatal("exported bytes differ from the selected version")
	}
	if err := os.WriteFile(path, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	output.Reset()
	if _, failure := transferExecute(t, e, "exportFile", params, nil, &output); failure != nil {
		t.Fatal(failure)
	}
	if output.String() != "changed" {
		t.Fatal("did not export current content")
	}

}

func TestBinaryExportRejectsFIFOWithoutWaitingForAWriter(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "pipe")
	if err := syscall.Mkfifo(path, 0600); err != nil {
		t.Fatal(err)
	}
	e := New(home, home)
	defer e.Close()
	result := make(chan string, 1)
	go func() {
		_, failure := transferExecute(t, e, "inspectExport", map[string]any{"path": path, "maxBytes": 64}, nil, nil)
		code := ""
		if failure != nil {
			code = failure.Code
		}
		result <- code
	}()
	select {
	case code := <-result:
		if code != "invalid" {
			t.Fatalf("wrong FIFO result: %s", code)
		}
	case <-time.After(time.Second):
		t.Fatal("export blocked waiting for a FIFO writer")
	}
}
