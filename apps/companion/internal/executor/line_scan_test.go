package executor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestReaderScanLinesPreservesNativeRangesAndDecodedSizes(t *testing.T) {
	long := strings.Repeat("x", 64*1024-1) + "🙂\nend"
	cases := []struct {
		name  string
		data  []byte
		start int64
		end   int64
		// newlines, start, end, firstLineEnd, lastLineStart, selectedBytes, firstLineBytes.
		want [7]int64
	}{
		{"unicode range", []byte("alpha\ncafé 🙂\nomega\n"), 1, 2, [7]int64{3, 6, 16, 16, 6, 10, 10}},
		{"CRLF", []byte("a\r\nb\r\n"), 0, 2, [7]int64{2, 0, 5, 2, 3, 5, 2}},
		{"empty", nil, 0, 0, [7]int64{}},
		{"trailing newline", []byte("one\n"), 1, 0, [7]int64{1, 4, 4, 4, 4, 0, 0}},
		{"past EOF", []byte("abc\nz"), 10, 12, [7]int64{1, 5, 5, 5, 5, 0, 0}},
		{"leading BOM", []byte("\ufeffA\ncafé"), 0, 1, [7]int64{1, 0, 4, 4, 0, 1, 1}},
		{"embedded BOM", []byte("a\n\ufeffb"), 1, 0, [7]int64{1, 2, 6, 6, 2, 4, 4}},
		{"invalid UTF8", []byte{0xef, 0xbb, 0xbf, 0xff, 0xe2, 0x82, '\n', 'x'}, 0, 1, [7]int64{1, 0, 6, 6, 0, 6, 6}},
		{"long line split Unicode", []byte(long), 0, 1, [7]int64{1, 0, 65539, 65539, 0, 65539, 65539}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			e := New(root, t.TempDir())
			defer e.Close()
			path := filepath.Join(root, "source.txt")
			if err := os.WriteFile(path, tc.data, 0600); err != nil {
				t.Fatal(err)
			}
			handle, failure := e.Execute(context.Background(), "openBinaryReader", mustJSON(map[string]any{"path": path}), "reader", nil)
			if failure != nil {
				t.Fatal(failure)
			}
			// Scanning must use the descriptor already opened, including after a rename.
			if err := os.Rename(path, path+".moved"); err != nil {
				t.Fatal(err)
			}
			params := map[string]any{"handle": handle, "startLine": tc.start}
			if tc.end != 0 {
				params["endLine"] = tc.end
			}
			value, failure := e.Execute(context.Background(), "readerScanLines", mustJSON(params), "scan", nil)
			if failure != nil {
				t.Fatal(failure)
			}
			var got map[string]int64
			if err := json.Unmarshal(mustJSON(value), &got); err != nil {
				t.Fatal(err)
			}
			keys := []string{"newlines", "start", "end", "firstLineEnd", "lastLineStart", "selectedBytes", "firstLineBytes"}
			want := make(map[string]int64, len(keys))
			for i, key := range keys {
				want[key] = tc.want[i]
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("scan = %#v, want %#v", got, want)
			}
		})
	}
}

func TestReaderScanLinesRejectsInvalidRangesAndClosedReaders(t *testing.T) {
	root := t.TempDir()
	e := New(root, t.TempDir())
	defer e.Close()
	path := filepath.Join(root, "note.txt")
	if err := os.WriteFile(path, []byte("hello\n"), 0600); err != nil {
		t.Fatal(err)
	}
	handle, failure := e.Execute(context.Background(), "openBinaryReader", mustJSON(map[string]any{"path": path}), "reader", nil)
	if failure != nil {
		t.Fatal(failure)
	}
	for _, bounds := range []map[string]any{{}, {"startLine": -1}, {"startLine": 0.5}, {"startLine": 1, "endLine": 1}, {"startLine": 0, "endLine": -1}} {
		bounds["handle"] = handle
		_, failure := e.Execute(context.Background(), "readerScanLines", mustJSON(bounds), "invalid", nil)
		if failure == nil || failure.Code != "invalid" || failure.Message != "Invalid line range" {
			t.Fatalf("invalid range: %#v", failure)
		}
	}
	if _, failure := e.Execute(context.Background(), "readerClose", mustJSON(map[string]any{"handle": handle}), "close", nil); failure != nil {
		t.Fatal(failure)
	}
	_, failure = e.Execute(context.Background(), "readerScanLines", mustJSON(map[string]any{"handle": handle, "startLine": 0}), "closed", nil)
	if failure == nil || failure.Code != "reader_expired" {
		t.Fatalf("closed reader: %#v", failure)
	}
}
