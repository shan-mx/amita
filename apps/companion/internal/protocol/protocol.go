package protocol

import (
	"encoding/json"
	"time"
)

const Version = 1
const FileChunkBytes = 64 << 10
const FileTransferTimeout = 120 * time.Second
const OutputType = "output"
const ExpiredBeforeStart = "expired_before_start"
const DefaultOutputMaxBytes = 50 * 1024
const ReaderScanLines = "readerScanLines"

// MaxFrameBytes matches the Cloudflare Workers WebSocket message limit.
const MaxFrameBytes int64 = 32 << 20

type Frame struct {
	Type      string          `json:"type"`
	ID        string          `json:"id,omitempty"`
	Protocol  int             `json:"protocol,omitempty"`
	Name      string          `json:"name,omitempty"`
	CWD       string          `json:"cwd,omitempty"`
	Home      string          `json:"home,omitempty"`
	OS        string          `json:"os,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Workspace string          `json:"workspace,omitempty"`
	Deadline  int64           `json:"deadline,omitempty"`
	After     int64           `json:"after,omitempty"`
	Reason    string          `json:"reason,omitempty"`
	Seq       int64           `json:"seq,omitempty"`
	Stream    string          `json:"stream,omitempty"`
	Content   string          `json:"content,omitempty"`
	Text      string          `json:"text,omitempty"`
	Snapshot  bool            `json:"snapshot,omitempty"`
	Before    OutputBoundary  `json:"before,omitempty"`
	Result    *Result         `json:"result,omitempty"`
}

type Result struct {
	OK    bool         `json:"ok"`
	Value any          `json:"value,omitempty"`
	Error *ResultError `json:"error,omitempty"`
}

func (r Result) MarshalJSON() ([]byte, error) {
	if r.OK {
		return json.Marshal(struct {
			OK    bool `json:"ok"`
			Value any  `json:"value"`
		}{true, r.Value})
	}
	return json.Marshal(struct {
		OK    bool         `json:"ok"`
		Error *ResultError `json:"error"`
	}{false, r.Error})
}

type ResultError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Path      string `json:"path,omitempty"`
	SpillPath string `json:"spillPath,omitempty"`
}

type Output struct {
	Type     string         `json:"type"`
	ID       string         `json:"id"`
	Seq      int64          `json:"seq"`
	Stream   string         `json:"stream"`
	Text     string         `json:"text"`
	Snapshot bool           `json:"snapshot"`
	Before   OutputBoundary `json:"before"`
}

type OutputBoundary struct {
	Bytes           int64 `json:"bytes"`
	Newlines        int64 `json:"newlines"`
	EndsWithNewline bool  `json:"endsWithNewline"`
}

type ResultFrame struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Seq    int64  `json:"seq"`
	Result Result `json:"result"`
}

type FileInfo struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Kind    string `json:"kind"`
	Size    int64  `json:"size"`
	MtimeMs int64  `json:"mtimeMs"`
}
