package rpc

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cohub/apps/sandbox/protocol"
)

func TestApplyFSEditsNormalizesRepresentationDifferences(t *testing.T) {
	content := "prefix  \r\nold  \r\nsuffix\t\r\n"
	updated, err := applyFSEdits(content, []fsEditItem{{OldText: "old\n", NewText: "new\n"}})
	if err != nil {
		t.Fatalf("apply edits: %v", err)
	}
	want := "prefix  \r\nnew\r\nsuffix\t\r\n"
	if updated != want {
		t.Fatalf("updated content = %q, want %q", updated, want)
	}
}

func TestApplyFSEditsKeepsNormalizedDuplicateMatchesAmbiguous(t *testing.T) {
	_, err := applyFSEdits("alpha  \r\nalpha\t\r\n", []fsEditItem{{OldText: "alpha\n", NewText: "x"}})
	matchErr, ok := err.(*editMatchError)
	if !ok {
		t.Fatalf("error = %T (%v), want editMatchError", err, err)
	}
	if matchErr.matches != 2 || len(matchErr.lines) != 2 || matchErr.lines[0] != 1 || matchErr.lines[1] != 2 {
		t.Fatalf("match error = %+v, want two matches on lines 1 and 2", matchErr)
	}
}

func TestApplyFSEditsPreservesBOMWhetherOldTextIncludesItOrNot(t *testing.T) {
	for _, oldText := range []string{"alpha", "\uFEFFalpha"} {
		updated, err := applyFSEdits("\uFEFFalpha\n", []fsEditItem{{OldText: oldText, NewText: "beta"}})
		if err != nil {
			t.Fatalf("apply edits with oldText %q: %v", oldText, err)
		}
		if updated != "\uFEFFbeta\n" {
			t.Fatalf("updated content = %q, want BOM-preserving replacement", updated)
		}
	}
}

func TestApplyFSEditsUsesSameFirstLineEndingForMixedNewlines(t *testing.T) {
	updated, err := applyFSEdits("a\rb\n", []fsEditItem{{OldText: "a\nb", NewText: "x\ny"}})
	if err != nil {
		t.Fatalf("apply edits: %v", err)
	}
	if updated != "x\ry\n" {
		t.Fatalf("updated content = %q, want first-ending preservation", updated)
	}
}

func TestApplyFSEditsCapsHighFrequencyMatchDiagnostics(t *testing.T) {
	_, err := applyFSEdits(strings.Repeat("a", 2_000_000), []fsEditItem{{OldText: "a", NewText: "b"}})
	matchErr, ok := err.(*editMatchError)
	if !ok {
		t.Fatalf("error = %T (%v), want editMatchError", err, err)
	}
	if !matchErr.truncated || matchErr.matches != maxEditMatches || len(matchErr.lines) != maxEditMatches {
		t.Fatalf("match error = %+v, want capped and truncated diagnostics", matchErr)
	}
}

func TestApplyFSEditsMatchesAgainstOriginalSnapshot(t *testing.T) {
	_, err := applyFSEdits("alpha\n", []fsEditItem{
		{OldText: "alpha", NewText: "beta"},
		{OldText: "beta", NewText: "gamma"},
	})
	matchErr, ok := err.(*editMatchError)
	if !ok {
		t.Fatalf("error = %T (%v), want editMatchError", err, err)
	}
	if matchErr.index != 1 || matchErr.matches != 0 {
		t.Fatalf("match error = %+v, want edit index 1 with zero matches", matchErr)
	}
}

func TestApplyFSEditsRejectsOverlappingRanges(t *testing.T) {
	_, err := applyFSEdits("alpha\n", []fsEditItem{
		{OldText: "alpha", NewText: "ALPHA"},
		{OldText: "alpha\n", NewText: "ALPHA\n"},
	})
	overlapErr, ok := err.(*editOverlapError)
	if !ok {
		t.Fatalf("error = %T (%v), want editOverlapError", err, err)
	}
	if overlapErr.first != 0 || overlapErr.second != 1 {
		t.Fatalf("overlap error = %+v, want edits 0 and 1", overlapErr)
	}
}

func TestFSEditMatchErrorIncludesRecoveryAndLineHints(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	if err := writeTextForEditTest(root, "a.txt", "alpha\nalpha\nbeta\n"); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	notFound := d.handleFSEdit(editRequest(t, fsEditParams{Path: "a.txt", Edits: []fsEditItem{{OldText: "alpah", NewText: "x"}}}))
	failed, ok := notFound.(protocol.RPCFailed)
	if !ok {
		t.Fatalf("not-found result = %T (%v)", notFound, notFound)
	}
	if !strings.Contains(failed.Error.Message, "Re-read the file and retry") {
		t.Fatalf("not-found message = %q, missing recovery instruction", failed.Error.Message)
	}

	notUnique := d.handleFSEdit(editRequest(t, fsEditParams{Path: "a.txt", Edits: []fsEditItem{{OldText: "alpha", NewText: "x"}}}))
	failed, ok = notUnique.(protocol.RPCFailed)
	if !ok {
		t.Fatalf("not-unique result = %T (%v)", notUnique, notUnique)
	}
	if !strings.Contains(failed.Error.Message, "lines [1, 2]") {
		t.Fatalf("not-unique message = %q, missing line hints", failed.Error.Message)
	}
}

func writeTextForEditTest(root, name, content string) error {
	return writeFileForEditTest(root, name, []byte(content))
}

func writeFileForEditTest(root, name string, content []byte) error {
	return os.WriteFile(filepath.Join(root, name), content, 0o644)
}
