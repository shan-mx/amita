package protocol

import (
	"encoding/json"
	"testing"
)

func TestSuccessfulVoidResultIncludesJSONNullValue(t *testing.T) {
	b, err := json.Marshal(Result{OK: true})
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"ok":true,"value":null}` {
		t.Fatalf("wire result = %s", b)
	}
}

func TestFailureResultOmitsValueAndIncludesError(t *testing.T) {
	b, err := json.Marshal(Result{OK: false, Error: &ResultError{Code: "aborted", Message: "stopped"}})
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"ok":false,"error":{"code":"aborted","message":"stopped"}}` {
		t.Fatalf("wire result = %s", b)
	}
}

func TestOutputSnapshotWireShape(t *testing.T) {
	f := Output{Type: OutputType, ID: "op", Seq: 7, Stream: "stderr", Text: "tail", Snapshot: true, Before: OutputBoundary{Bytes: 12, Newlines: 2, EndsWithNewline: true}}
	b, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"output","id":"op","seq":7,"stream":"stderr","text":"tail","snapshot":true,"before":{"bytes":12,"newlines":2,"endsWithNewline":true}}`
	if string(b) != want {
		t.Fatalf("output wire=%s want=%s", b, want)
	}
}
