package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func resetCacheState(t *testing.T) {
	t.Helper()
	t.Setenv("HARNESS_LSP_CL", "")
	t.Setenv("HARNESS_LSP_DOTNET", "")
	mu.Lock()
	docs = map[string]*doc{}
	index = map[string][]symbol{}
	fileCache = map[string]string{}
	revisions = map[string]uint64{}
	mu.Unlock()
}

func cacheParams(value any) json.RawMessage {
	b, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return b
}

func cacheOpen(uri, text string) {
	handleDidOpen(cacheParams(map[string]any{"textDocument": map[string]any{"uri": uri, "text": text, "version": 1}}))
}

func cacheChange(uri, text string) {
	handleDidChange(cacheParams(map[string]any{"textDocument": map[string]any{"uri": uri, "version": 2}, "contentChanges": []any{map[string]any{"text": text}}}))
}

func cacheClose(uri string) {
	handleDidClose(cacheParams(map[string]any{"textDocument": map[string]any{"uri": uri}}))
}

func cacheWatch(uri string, kind int) {
	handleDidChangeWatchedFiles(cacheParams(map[string]any{"changes": []any{map[string]any{"uri": uri, "type": kind}}}))
}

func cacheFile(t *testing.T) (string, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sample.cpp")
	cacheWrite(t, path, "void DiskName() {}")
	return path, uriOfPath(path)
}

func cacheWrite(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}

func assertCachedSymbol(t *testing.T, uri, text, name string) {
	t.Helper()
	mu.RLock()
	defer mu.RUnlock()
	got := fileCache[uri]
	if d := docs[uri]; d != nil {
		got = d.Text
	}
	if got != text {
		t.Fatalf("text = %q, want %q", got, text)
	}
	if syms := index[uri]; len(syms) != 1 || syms[0].Name != name {
		t.Fatalf("symbols = %+v, want %s", syms, name)
	}
}

func TestCloseReloadsSavedDisk(t *testing.T) {
	for _, watch := range []bool{false, true} {
		t.Run(map[bool]string{false: "without_watcher", true: "with_watcher"}[watch], func(t *testing.T) {
			resetCacheState(t)
			path, uri := cacheFile(t)
			ensureIndexed(uri)
			cacheOpen(uri, "void DiskName() {}")
			cacheChange(uri, "void SavedName() {}")
			cacheWrite(t, path, "void SavedName() {}")
			if watch {
				cacheWatch(uri, 2)
			}
			cacheClose(uri)
			assertCachedSymbol(t, uri, "void SavedName() {}", "SavedName")
		})
	}
}

func TestCloseDiscardsUnsavedBuffer(t *testing.T) {
	resetCacheState(t)
	_, uri := cacheFile(t)
	ensureIndexed(uri)
	cacheOpen(uri, "void UnsavedName() {}")
	cacheClose(uri)
	assertCachedSymbol(t, uri, "void DiskName() {}", "DiskName")
}

func TestDeletedFileCloseClearsCache(t *testing.T) {
	resetCacheState(t)
	path, uri := cacheFile(t)
	ensureIndexed(uri)
	cacheOpen(uri, "void BufferName() {}")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	cacheWatch(uri, 3)
	assertCachedSymbol(t, uri, "void BufferName() {}", "BufferName")
	cacheClose(uri)
	if _, ok := docText(uri); ok {
		t.Fatal("deleted file retained text")
	}
	if len(findDefs("BufferName"))+len(findDefs("DiskName")) != 0 {
		t.Fatal("deleted file retained symbols")
	}
}

func TestWorkspaceScanKeepsOpenBuffer(t *testing.T) {
	resetCacheState(t)
	path, uri := cacheFile(t)
	cacheOpen(uri, "void BufferName() {}")
	walkWorkspace(filepath.Dir(path))
	ensureIndexed(uri)
	cacheWatch(uri, 2)
	assertCachedSymbol(t, uri, "void BufferName() {}", "BufferName")
}

func TestStaleDiskPublicationRejected(t *testing.T) {
	for _, event := range []string{"open", "change", "close", "watch", "delete"} {
		t.Run(event, func(t *testing.T) {
			resetCacheState(t)
			path, uri := cacheFile(t)
			revision, needed := diskRevision(uri)
			if !needed {
				t.Fatal("expected disk indexing")
			}
			stale := "void DiskName() {}"
			syms := parseSymbols(uri, stale)
			switch event {
			case "open":
				cacheOpen(uri, "void BufferName() {}")
			case "change":
				cacheOpen(uri, stale)
				cacheChange(uri, "void BufferName() {}")
			case "close":
				cacheOpen(uri, stale)
				cacheWrite(t, path, "void NewName() {}")
				cacheClose(uri)
			case "watch":
				cacheWrite(t, path, "void NewName() {}")
				cacheWatch(uri, 2)
			case "delete":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				cacheWatch(uri, 3)
			}
			if publishDisk(uri, stale, syms, revision) {
				t.Fatal("stale read published after ownership changed")
			}
			switch event {
			case "open", "change":
				assertCachedSymbol(t, uri, "void BufferName() {}", "BufferName")
			case "close", "watch":
				assertCachedSymbol(t, uri, "void NewName() {}", "NewName")
			case "delete":
				if _, ok := docText(uri); ok {
					t.Fatal("deleted file restored")
				}
			}
		})
	}
}

func TestConcurrentDiskAndBufferUpdates(t *testing.T) {
	resetCacheState(t)
	path, uri := cacheFile(t)
	var wg sync.WaitGroup
	for worker := 0; worker < 4; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < 25; i++ {
				switch worker {
				case 0:
					walkWorkspace(filepath.Dir(path))
				case 1:
					ensureIndexed(uri)
					cacheWatch(uri, 2)
				case 2:
					cacheOpen(uri, "void OpenName() {}")
					cacheChange(uri, "void ChangedName() {}")
				case 3:
					cacheClose(uri)
				}
			}
		}(worker)
	}
	wg.Wait()
	cacheOpen(uri, "void FinalName() {}")
	assertCachedSymbol(t, uri, "void FinalName() {}", "FinalName")
	cacheClose(uri)
	assertCachedSymbol(t, uri, "void DiskName() {}", "DiskName")
}
