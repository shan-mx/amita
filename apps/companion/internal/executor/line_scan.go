package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"

	"github.com/shan-mx/amita/apps/companion/internal/protocol"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

const lineScanBufferBytes = 64 << 10
const maxSafeInteger = 1<<53 - 1

// lineScan implements Pi's BinaryReader.scanLines contract. Positions are raw
// file offsets; byte counts describe the UTF-8 text after decoding.
type lineScan struct {
	Newlines       int64 `json:"newlines"`
	Start          int64 `json:"start"`
	End            int64 `json:"end"`
	FirstLineEnd   int64 `json:"firstLineEnd"`
	LastLineStart  int64 `json:"lastLineStart"`
	SelectedBytes  int64 `json:"selectedBytes"`
	FirstLineBytes int64 `json:"firstLineBytes"`
}

type decodedByteCount struct{ total *int64 }

func (c decodedByteCount) Write(p []byte) (int, error) {
	*c.total += int64(len(p))
	return len(p), nil
}

type lineScanner struct {
	result              lineScan
	startLine, endLine  int64
	position, lineStart int64
	bom                 bool
	selection, first    *transform.Writer
}

func (e *Executor) scanReaderLines(ctx context.Context, raw json.RawMessage) (any, *protocol.ResultError) {
	var params struct {
		Handle    string `json:"handle"`
		StartLine *int64 `json:"startLine"`
		EndLine   *int64 `json:"endLine"`
	}
	if err := json.Unmarshal(raw, &params); err != nil || params.StartLine == nil ||
		*params.StartLine < 0 || *params.StartLine > maxSafeInteger ||
		(params.EndLine != nil && (*params.EndLine <= *params.StartLine || *params.EndLine > maxSafeInteger)) {
		return nil, fail("invalid", "Invalid line range", "")
	}
	f := e.reader(params.Handle)
	if f == nil {
		return nil, fail("reader_expired", "The file read was interrupted. Call fs_read again on the same path.", "")
	}
	scanner := lineScanner{
		result:    lineScan{Start: -1, End: -1, FirstLineEnd: -1, LastLineStart: -1},
		startLine: *params.StartLine,
		endLine:   math.MaxInt64,
	}
	if params.EndLine != nil {
		scanner.endLine = *params.EndLine
	}
	if scanner.startLine == 0 {
		scanner.begin(0)
	}
	var head [3]byte
	n, err := f.ReadAt(head[:], 0)
	if err != nil && err != io.EOF {
		return nil, mapError(err, f.Name())
	}
	scanner.bom = n == len(head) && bytes.Equal(head[:], []byte{0xef, 0xbb, 0xbf})
	buffer := make([]byte, lineScanBufferBytes)
	for {
		if failure := checkContext(ctx, f.Name()); failure != nil {
			return nil, failure
		}
		n, err := f.ReadAt(buffer, scanner.position)
		if n > 0 {
			if scanErr := scanner.push(buffer[:n]); scanErr != nil {
				return nil, mapError(scanErr, f.Name())
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, mapError(err, f.Name())
		}
	}
	if failure := checkContext(ctx, f.Name()); failure != nil {
		return nil, failure
	}
	result, err := scanner.finish()
	if err != nil {
		return nil, mapError(err, f.Name())
	}
	return result, nil
}

func (s *lineScanner) begin(position int64) {
	s.result.Start = position
	if s.startLine == s.endLine-1 {
		s.result.LastLineStart = position
	}
	s.selection = transform.NewWriter(decodedByteCount{&s.result.SelectedBytes}, unicode.UTF8.NewDecoder())
	s.first = transform.NewWriter(decodedByteCount{&s.result.FirstLineBytes}, unicode.UTF8.NewDecoder())
}

func (s *lineScanner) endFirst(position int64) error {
	s.result.FirstLineEnd = position
	if s.first == nil {
		return nil
	}
	err := s.first.Close()
	s.first = nil
	return err
}

func (s *lineScanner) endSelection(position int64) error {
	s.result.End = position
	if s.selection == nil {
		return nil
	}
	err := s.selection.Close()
	s.selection = nil
	return err
}

func (s *lineScanner) feed(chunk []byte, from, to int) error {
	if s.bom && s.position+int64(from) < 3 {
		from = min(to, int(3-s.position))
	}
	if from >= to {
		return nil
	}
	if s.selection != nil {
		if _, err := s.selection.Write(chunk[from:to]); err != nil {
			return err
		}
	}
	if s.first != nil {
		if _, err := s.first.Write(chunk[from:to]); err != nil {
			return err
		}
	}
	return nil
}

func (s *lineScanner) push(chunk []byte) error {
	from := 0
	for {
		relative := bytes.IndexByte(chunk[from:], '\n')
		if relative < 0 {
			break
		}
		index := from + relative
		if err := s.feed(chunk, from, index); err != nil {
			return err
		}
		position := s.position + int64(index)
		if s.result.Newlines == s.startLine {
			if err := s.endFirst(position); err != nil {
				return err
			}
		}
		if s.result.Newlines == s.endLine-1 {
			if err := s.endSelection(position); err != nil {
				return err
			}
		}
		if err := s.feed(chunk, index, index+1); err != nil {
			return err
		}
		from = index + 1
		s.result.Newlines++
		s.lineStart = position + 1
		if s.result.Newlines == s.startLine {
			s.begin(s.lineStart)
		}
		if s.result.Newlines == s.endLine-1 {
			s.result.LastLineStart = s.lineStart
		}
	}
	if err := s.feed(chunk, from, len(chunk)); err != nil {
		return err
	}
	s.position += int64(len(chunk))
	return nil
}

func (s *lineScanner) finish() (lineScan, error) {
	if s.result.Start < 0 {
		return lineScan{Newlines: s.result.Newlines, Start: s.position, End: s.position, FirstLineEnd: s.position, LastLineStart: s.position}, nil
	}
	if s.result.FirstLineEnd < 0 {
		if err := s.endFirst(s.position); err != nil {
			return lineScan{}, err
		}
	}
	if s.result.End < 0 {
		if err := s.endSelection(s.position); err != nil {
			return lineScan{}, err
		}
	}
	if s.result.LastLineStart < 0 {
		s.result.LastLineStart = s.lineStart
	}
	return s.result, nil
}
