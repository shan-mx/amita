package client

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/shan-mx/amita/apps/companion/internal/config"
	"github.com/shan-mx/amita/apps/companion/internal/protocol"
)

func TestFileTransferStreamsBytes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	root := t.TempDir()
	destination := filepath.Join(root, "received.bin")
	body := bytes.Repeat([]byte{0, 255, 128, 71}, 5*1024*1024)
	observed := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		conn, err := websocket.Accept(w, req, nil)
		if err != nil {
			observed <- err
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		conn.SetReadLimit(protocol.MaxFrameBytes)
		run := func() error {
			send := func(frame any) error {
				raw, err := json.Marshal(frame)
				if err != nil {
					return err
				}
				return conn.Write(ctx, websocket.MessageText, raw)
			}
			read := func() (protocol.Frame, error) {
				_, raw, err := conn.Read(ctx)
				if err != nil {
					return protocol.Frame{}, err
				}
				var f protocol.Frame
				err = json.Unmarshal(raw, &f)
				return f, err
			}
			if _, err := read(); err != nil {
				return err
			}
			if err := send(protocol.Frame{Type: "ready"}); err != nil {
				return err
			}
			params, _ := json.Marshal(map[string]any{"path": destination, "transferId": "file", "maxBytes": len(body)})
			if err := send(protocol.Frame{Type: "file_request", ID: "upload", Method: "importFile", Params: params}); err != nil {
				return err
			}
			for offset := 0; offset < len(body); offset += protocol.FileChunkBytes {
				if err := send(protocol.Frame{Type: "file_chunk", ID: "upload", Content: base64.StdEncoding.EncodeToString(body[offset : offset+protocol.FileChunkBytes])}); err != nil {
					return err
				}
			}
			if err := send(protocol.Frame{Type: "file_end", ID: "upload"}); err != nil {
				return err
			}
			frame, err := read()
			if err != nil {
				return err
			}
			if frame.Type != "file_result" || frame.Result == nil || !frame.Result.OK {
				return fmt.Errorf("upload failed: %+v", frame)
			}
			params, _ = json.Marshal(map[string]any{"path": destination, "maxBytes": len(body)})
			if err := send(protocol.Frame{Type: "file_request", ID: "export", Method: "exportFile", Params: params}); err != nil {
				return err
			}
			var exported bytes.Buffer
			for {
				frame, err = read()
				if err != nil {
					return err
				}
				if frame.Type == "file_chunk" {
					chunk, err := base64.StdEncoding.DecodeString(frame.Content)
					if err != nil {
						return err
					}
					exported.Write(chunk)
				} else if frame.Type == "file_result" {
					if frame.Result == nil || !frame.Result.OK {
						return fmt.Errorf("export failed: %+v", frame)
					}
					break
				} else {
					return fmt.Errorf("unexpected file frame: %s", frame.Type)
				}
			}
			if !bytes.Equal(exported.Bytes(), body) {
				return fmt.Errorf("exported binary content differs")
			}
			return nil
		}
		observed <- run()
		<-ctx.Done()
	}))
	defer func() { cancel(); server.Close() }()
	runner := &Runner{StateDir: filepath.Join(root, "state"), Config: config.Config{Server: server.URL, DeviceID: "device", Credential: "test", Name: "test", CWD: root}, Home: root}
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	select {
	case err := <-observed:
		if err != nil {
			t.Error(err)
		}
	case <-ctx.Done():
		t.Error("file transfer timed out")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
