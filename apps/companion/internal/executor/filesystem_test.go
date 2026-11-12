package executor

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/shan-mx/amita/apps/companion/internal/protocol"
)

func fsExecute(t *testing.T, e *Executor, method string, params map[string]any) (any, *protocol.ResultError) {
	t.Helper()
	b, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	return e.Execute(context.Background(), method, b, "", nil)
}
func TestTextReadPreservesBytesForNativeUTF8Decoding(t *testing.T) {
	root := t.TempDir()
	e := New(root, t.TempDir())
	defer e.Close()
	for _, contents := range [][]byte{[]byte("Hello 📄"), {0xef, 0xbb, 0xbf, 'x'}, {0xff, 0xff, 0xe2, 0x82}} {
		path := filepath.Join(root, "note.txt")
		if err := os.WriteFile(path, contents, 0600); err != nil {
			t.Fatal(err)
		}
		got, failure := fsExecute(t, e, "readTextFile", map[string]any{"path": path})
		if failure != nil {
			t.Fatal(failure)
		}
		decoded, err := base64.StdEncoding.DecodeString(got.(string))
		if err != nil || string(decoded) != string(contents) {
			t.Fatalf("read bytes = %v (%v)", decoded, err)
		}
	}
	for _, params := range []map[string]any{{"path": "invalid\x00path"}, {"path": "note.txt", "cwd": "invalid\x00cwd"}} {
		if _, failure := fsExecute(t, e, "readTextFile", params); failure == nil || failure.Code != "invalid" {
			t.Fatalf("invalid path: %#v", failure)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, failure := e.Execute(ctx, "readTextFile", json.RawMessage("{\"path\":\"note.txt\"}"), "", nil); failure == nil || failure.Code != "aborted" {
		t.Fatalf("cancelled read: %#v", failure)
	}
}

func TestListDirIsSupportedAndPaged(t *testing.T) {
	root := t.TempDir()
	const lastFilename = "notes 📄 %1.txt"
	for _, name := range []string{lastFilename, "b.txt", "a.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("ok"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	e := New(root, filepath.Join(root, "state"))
	defer e.Close()
	got, er := fsExecute(t, e, "listDir", map[string]any{"path": ".", "limit": 2})
	if er != nil {
		t.Fatalf("listDir returned %q: %s", er.Code, er.Message)
	}
	page := got.(directoryResult)
	if len(page.Entries) != 2 || page.Entries[0].Name != "a.txt" || page.NextCursor != "b.txt" {
		t.Fatalf("first page = %#v", page)
	}
	got, er = fsExecute(t, e, "listDir", map[string]any{"path": ".", "limit": 2, "cursor": page.NextCursor})
	if er != nil || got.(directoryResult).Entries[0].Name != lastFilename {
		t.Fatalf("second page = %#v, error=%v", got, er)
	}
}

func TestGlobDoubleStarAndDoesNotFollowDirectorySymlinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "nested", "deeper"), 0755); err != nil {
		t.Fatal(err)
	}
	nestedFile := filepath.Join(root, "nested", "deeper", "draft 📄.txt")
	if err := os.WriteFile(nestedFile, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := os.Symlink(root, filepath.Join(root, "nested", "cycle")); err != nil {
		t.Fatal(err)
	}
	e := New(root, filepath.Join(root, "state"))
	defer e.Close()
	got, er := fsExecute(t, e, "glob", map[string]any{"path": ".", "pattern": "**/*.txt"})
	if er != nil {
		t.Fatal(er)
	}
	result := got.(globResult)
	if len(result.Paths) != 1 || result.Paths[0] != nestedFile {
		t.Fatalf("glob paths = %#v", result.Paths)
	}
}

func TestSearchUsesWorkspacePatternsAndLineBoundaries(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "nested"), 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"[ab].md", "a.md", "b.md", "nested/a.md", "nested-.md"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("\uFEFFneedle\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	e := New(root, filepath.Join(root, "state"))
	defer e.Close()

	for _, tc := range []struct {
		pattern string
		names   []string
	}{
		{"[ab].md", []string{"[ab].md"}},
		{"**/{a,b}.md", []string{"a.md", "b.md", "nested/a.md"}},
		{"**/*.md", []string{"[ab].md", "a.md", "b.md", "nested/a.md", "nested-.md"}},
	} {
		got, er := fsExecute(t, e, "glob", map[string]any{"path": root, "pattern": tc.pattern})
		if er != nil {
			t.Fatal(er)
		}
		want := make([]string, 0, len(tc.names))
		for _, name := range tc.names {
			want = append(want, filepath.Join(root, name))
		}
		if paths := got.(globResult).Paths; !slices.Equal(paths, want) {
			t.Fatalf("glob %q: got %q, want %q", tc.pattern, paths, want)
		}
	}

	got, er := fsExecute(t, e, "grep", map[string]any{
		"path": root, "pattern": "^needle$", "include": "{a,b}.md",
	})
	if er != nil {
		t.Fatal(er)
	}
	matches := got.(grepResult).Matches
	if len(matches) != 2 {
		t.Fatalf("grep matches = %#v", matches)
	}
	for i, name := range []string{"a.md", "b.md"} {
		match := matches[i]
		if match.Path != filepath.Join(root, name) || match.Line != 1 || match.Text != "needle" || len(match.After) != 0 {
			t.Fatalf("grep match = %#v", match)
		}
	}
}

func TestGrepLiteralContextInvalidRegexAndBudgets(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "notes.txt")
	if err := os.WriteFile(path, []byte("zero\nHello CAFÉ\nend\n"), 0600); err != nil {
		t.Fatal(err)
	}
	e := New(root, filepath.Join(root, "state"))
	defer e.Close()
	got, er := fsExecute(t, e, "grep", map[string]any{"path": path, "pattern": "hello café", "literal": true, "caseSensitive": false, "context": 1})
	if er != nil {
		t.Fatal(er)
	}
	result := got.(grepResult)
	if len(result.Matches) != 1 || result.Matches[0].Line != 2 || result.Matches[0].Before[0] != "zero" || result.Matches[0].After[0] != "end" {
		t.Fatalf("grep result = %#v", result)
	}
	got, er = fsExecute(t, e, "grep", map[string]any{"path": path, "pattern": "e", "literal": true, "limit": 1})
	if er != nil || !got.(grepResult).Truncated {
		t.Fatalf("limited grep = %#v, error=%v", got, er)
	}
	_, er = fsExecute(t, e, "grep", map[string]any{"path": path, "pattern": "["})
	if er == nil || er.Code != "invalid" {
		t.Fatalf("invalid regexp error = %#v", er)
	}
	_, er = fsExecute(t, e, "grep", map[string]any{"path": path, "pattern": "x", "context": grepMaxContext + 1})
	if er == nil || er.Code != "invalid" {
		t.Fatalf("context error = %#v", er)
	}
}

func TestGrepTraversesExplicitDirectorySymlinkAndPreservesAliasPath(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "note.txt"), []byte("needle\n"), 0600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "workspace-link")
	if err := os.Symlink(root, alias); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	e := New(root, filepath.Join(root, "state"))
	defer e.Close()
	got, er := fsExecute(t, e, "grep", map[string]any{"path": alias, "pattern": "needle", "literal": true})
	if er != nil {
		t.Fatal(er)
	}
	result := got.(grepResult)
	if len(result.Matches) != 1 || result.Matches[0].Path != filepath.Join(alias, "note.txt") {
		t.Fatalf("grep through symlink root = %#v", result)
	}
}

func TestWriteUsesExistingInodeAndSymlinkTarget(t *testing.T) {
	root := t.TempDir()
	path, hardlink, symlink := filepath.Join(root, "value"), filepath.Join(root, "hard"), filepath.Join(root, "sym")
	if err := os.WriteFile(path, []byte("old"), 0640); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(path, hardlink); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(path, symlink); err != nil {
		t.Fatal(err)
	}
	e := New(root, t.TempDir())
	defer e.Close()
	for _, target := range []string{path, symlink} {
		if _, err := fsExecute(t, e, "writeFile", map[string]any{"path": target, "content": target}); err != nil {
			t.Fatal(err)
		}
		for _, alias := range []string{path, hardlink, symlink} {
			data, err := os.ReadFile(alias)
			if err != nil || string(data) != target {
				t.Fatalf("%s contents %q (%v)", alias, data, err)
			}
		}
	}
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0640 {
		t.Fatalf("permissions: %v (%v)", st, err)
	}
	st, err = os.Lstat(symlink)
	if err != nil || st.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("symlink replaced: %v (%v)", st, err)
	}
}

func TestRecursiveRemoveReportsPartialDeletion(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read the protected directory")
	}
	root := t.TempDir()
	tree := filepath.Join(root, "tree")
	blocked := filepath.Join(tree, "z-blocked")
	if err := os.MkdirAll(blocked, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(blocked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(blocked, 0755) })
	first := filepath.Join(tree, "a.txt")
	if err := os.WriteFile(first, []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	e := New(root, filepath.Join(root, "state"))
	defer e.Close()
	_, er := fsExecute(t, e, "remove", map[string]any{"path": tree, "recursive": true})
	if er == nil || er.Code != "permission_denied" || !strings.Contains(er.Message, "partially deleted") || !strings.Contains(er.Message, "fs_list") {
		t.Fatalf("recursive removal error = %#v", er)
	}
	if _, err := os.Stat(first); !os.IsNotExist(err) {
		t.Fatalf("first entry should have been removed: %v", err)
	}
	if _, err := os.Stat(blocked); err != nil {
		t.Fatalf("blocked directory should remain: %v", err)
	}
}

func TestRemoveUnlinksSymlinkAndHonorsContext(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	e := New(root, filepath.Join(root, "state"))
	defer e.Close()
	_, er := fsExecute(t, e, "remove", map[string]any{"path": link})
	if er != nil {
		t.Fatal(er)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("symlink target removed: %v", err)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("symlink remains: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, er = e.Execute(ctx, "mkdir", json.RawMessage(`{"path":"cancelled"}`), "", nil)
	if er == nil || er.Code != "aborted" {
		t.Fatalf("cancel error = %#v", er)
	}
}

func TestMkdirRemoveAndPathValidation(t *testing.T) {
	root := t.TempDir()
	e := New(root, filepath.Join(root, "state"))
	defer e.Close()
	_, er := fsExecute(t, e, "mkdir", map[string]any{"path": "new/nested", "recursive": true})
	if er != nil {
		t.Fatal(er)
	}
	_, er = fsExecute(t, e, "remove", map[string]any{"path": "new"})
	if er == nil || er.Code != "not_empty" {
		t.Fatalf("remove error = %#v", er)
	}
	_, er = fsExecute(t, e, "remove", map[string]any{"path": "new", "recursive": true})
	if er != nil {
		t.Fatal(er)
	}
	_, er = fsExecute(t, e, "listDir", map[string]any{"path": ""})
	if er == nil || er.Code != "invalid" {
		t.Fatalf("empty path error = %#v", er)
	}
	if strings.Contains(er.Message, "\x00") {
		t.Fatal("unexpected NUL")
	}
}

func TestWorkspacePathsUseEachExecutorHomeAndKeepExplicitAccess(t *testing.T) {
	const relativeRoot = ".amita/workspaces"
	agents := []string{"8e994a94-7e8b-4fc2-bdb6-9ccde14c23b6", "f277ea2e-640f-49cf-a84d-8a659cdf77c2"}
	for _, label := range []string{"computer-a", "computer-b"} {
		t.Run(label, func(t *testing.T) {
			hostHome := t.TempDir()
			e := New(hostHome, t.TempDir())
			defer e.Close()
			for _, agent := range agents {
				workspace := filepath.Join(hostHome, relativeRoot, agent)
				if _, er := fsExecute(t, e, "mkdir", map[string]any{"path": "~/" + relativeRoot + "/" + agent, "recursive": true}); er != nil {
					t.Fatal(er)
				}
				if _, er := fsExecute(t, e, "writeFile", map[string]any{"cwd": workspace, "path": "owned.txt", "content": agent}); er != nil {
					t.Fatal(er)
				}
				data, err := os.ReadFile(filepath.Join(workspace, "owned.txt"))
				if err != nil || string(data) != agent {
					t.Fatalf("workspace content: %q, %v", data, err)
				}
			}
			outside := t.TempDir()
			if _, er := fsExecute(t, e, "writeFile", map[string]any{"cwd": outside, "path": "external.txt", "content": "authorized"}); er != nil {
				t.Fatal(er)
			}
			if data, err := os.ReadFile(filepath.Join(outside, "external.txt")); err != nil || string(data) != "authorized" {
				t.Fatalf("explicit outside access: %q, %v", data, err)
			}
		})
	}
}

func TestBusyMutationsReturnConflict(t *testing.T) {
	for _, method := range []string{"writeFile", "mkdir", "remove"} {
		t.Run(method, func(t *testing.T) {
			root := t.TempDir()
			e := New(root, t.TempDir())
			defer e.Close()
			path := filepath.Join(root, "target")
			if method != "mkdir" {
				if err := os.WriteFile(path, []byte("before"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			e.mutationMu.Lock()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			_, failure := e.Execute(ctx, method, json.RawMessage(`{"path":"`+path+`","content":"after"}`), "", nil)
			cancel()
			e.mutationMu.Unlock()
			if failure == nil || failure.Code != "conflict" {
				t.Fatalf("busy mutation: %#v", failure)
			}
			if method == "mkdir" {
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatalf("mkdir changed target: %v", err)
				}
			} else if data, err := os.ReadFile(path); err != nil || string(data) != "before" {
				t.Fatalf("target changed: %q %v", data, err)
			}
			if _, failure := fsExecute(t, e, method, map[string]any{"path": path, "content": "after"}); failure != nil {
				t.Fatal(failure)
			}
		})
	}
}
