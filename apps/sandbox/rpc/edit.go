package rpc

import (
	"fmt"
	"sort"
	"strings"
)

type editReplacement struct {
	index   int
	start   int
	end     int
	newText string
}

type editMatch struct {
	start int
	end   int
	fuzzy bool
}

type editMatchError struct {
	index   int
	matches int
	lines   []int
}

func (e *editMatchError) Error() string {
	return fmt.Sprintf("edit %d matched %d regions", e.index+1, e.matches)
}

type editInputError struct {
	index   int
	message string
}

func (e *editInputError) Error() string {
	return fmt.Sprintf("edits[%d].%s", e.index, e.message)
}

type editOverlapError struct {
	first  int
	second int
}

func (e *editOverlapError) Error() string {
	return fmt.Sprintf("edits[%d] and edits[%d] overlap", e.first, e.second)
}

type normalizedEditText struct {
	text    string
	offsets []int
}

// normalizeEditText only removes representational differences that are safe to
// repair without changing untouched lines: CRLF/CR line endings and spaces or
// tabs at the end of a line. offsets maps normalized byte boundaries back to
// the original content so fuzzy edits preserve the rest of the file verbatim.
func normalizeEditText(text string) normalizedEditText {
	var normalized strings.Builder
	offsets := make([]int, 1, len(text)+1)

	for lineStart := 0; lineStart < len(text); {
		lineEnd := lineStart
		for lineEnd < len(text) && text[lineEnd] != '\n' && text[lineEnd] != '\r' {
			lineEnd++
		}

		contentEnd := lineEnd
		for contentEnd > lineStart && (text[contentEnd-1] == ' ' || text[contentEnd-1] == '\t') {
			contentEnd--
		}
		normalized.WriteString(text[lineStart:contentEnd])
		for index := lineStart; index < contentEnd; index++ {
			offsets = append(offsets, index+1)
		}

		if lineEnd == len(text) {
			break
		}
		newlineEnd := lineEnd + 1
		if text[lineEnd] == '\r' && newlineEnd < len(text) && text[newlineEnd] == '\n' {
			newlineEnd++
		}
		normalized.WriteByte('\n')
		offsets = append(offsets, newlineEnd)
		lineStart = newlineEnd
	}

	return normalizedEditText{text: normalized.String(), offsets: offsets}
}

func findEditOccurrences(text, pattern string) []int {
	if pattern == "" {
		return nil
	}
	occurrences := make([]int, 0, 1)
	for cursor := 0; cursor <= len(text)-len(pattern); {
		relative := strings.Index(text[cursor:], pattern)
		if relative < 0 {
			break
		}
		index := cursor + relative
		occurrences = append(occurrences, index)
		cursor = index + len(pattern)
	}
	return occurrences
}

func findEditMatches(content, oldText string) []editMatch {
	exactOccurrences := findEditOccurrences(content, oldText)
	if len(exactOccurrences) > 0 {
		matches := make([]editMatch, 0, len(exactOccurrences))
		for _, start := range exactOccurrences {
			matches = append(matches, editMatch{start: start, end: start + len(oldText)})
		}
		return matches
	}

	normalizedContent := normalizeEditText(content)
	normalizedOldText := normalizeEditText(oldText)
	if normalizedOldText.text == "" {
		return nil
	}
	normalizedOccurrences := findEditOccurrences(normalizedContent.text, normalizedOldText.text)
	matches := make([]editMatch, 0, len(normalizedOccurrences))
	for _, start := range normalizedOccurrences {
		end := start + len(normalizedOldText.text)
		if start >= len(normalizedContent.offsets) || end >= len(normalizedContent.offsets) {
			continue
		}
		matches = append(matches, editMatch{
			start: normalizedContent.offsets[start],
			end:   normalizedContent.offsets[end],
			fuzzy: true,
		})
	}
	return matches
}

func editLineNumber(content string, offset int) int {
	if offset < 0 {
		offset = 0
	}
	if offset > len(content) {
		offset = len(content)
	}
	return len(splitEditLines(content[:offset]))
}

func editLineEnding(content string) string {
	if strings.Contains(content, "\r\n") {
		return "\r\n"
	}
	if strings.Contains(content, "\r") && !strings.Contains(content, "\n") {
		return "\r"
	}
	return "\n"
}

func restoreEditLineEndings(text, content string) string {
	normalized := strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
	ending := editLineEnding(content)
	if ending == "\n" {
		return normalized
	}
	return strings.ReplaceAll(normalized, "\n", ending)
}

func splitEditLines(text string) []string {
	return strings.Split(strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n"), "\n")
}

func editTokens(text string) []string {
	var tokens []string
	var current strings.Builder
	flush := func() {
		if current.Len() >= 4 {
			tokens = append(tokens, current.String())
		}
		current.Reset()
	}
	for _, char := range text {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || strings.ContainsRune("_./:-", char) {
			current.WriteRune(char)
			continue
		}
		flush()
	}
	flush()
	return tokens
}

func editHintBlock(content, oldText string) string {
	contentLines := splitEditLines(content)
	oldLines := splitEditLines(oldText)
	candidates := make([]string, 0, len(oldLines)+4)
	for _, line := range oldLines {
		line = strings.TrimSpace(line)
		if len(line) >= 4 {
			candidates = append(candidates, line)
		}
	}
	candidates = append(candidates, editTokens(oldText)...)
	sort.SliceStable(candidates, func(left, right int) bool { return len(candidates[left]) > len(candidates[right]) })
	for _, candidate := range candidates {
		lineIndex := -1
		for index, line := range contentLines {
			if strings.Contains(line, candidate) {
				lineIndex = index
				break
			}
		}
		if lineIndex < 0 {
			continue
		}
		start := lineIndex - 1
		if start < 0 {
			start = 0
		}
		end := lineIndex + 2
		if end > len(contentLines) {
			end = len(contentLines)
		}
		var hint strings.Builder
		for index := start; index < end; index++ {
			line := contentLines[index]
			lineRunes := []rune(line)
			if len(lineRunes) > 240 {
				line = string(lineRunes[:240]) + "..."
			}
			if hint.Len() > 0 {
				hint.WriteByte('\n')
			}
			fmt.Fprintf(&hint, "%d: %s", index+1, line)
		}
		return hint.String()
	}
	return ""
}

func formatFSEditMatchError(path, content string, matchErr *editMatchError, oldText string, total int) string {
	label := "oldText"
	if total > 1 {
		label = fmt.Sprintf("edits[%d].oldText", matchErr.index)
	}
	if matchErr.matches == 0 {
		hintBlock := editHintBlock(content, oldText)
		if hintBlock != "" {
			return fmt.Sprintf("%s must match exactly one region in %s, found 0. Re-read the file and retry with the current text, including whitespace, newlines, and escaping. Current nearby text:\n%s\nCopy the current text exactly; do not reuse stale oldText", label, path, hintBlock)
		}
		return fmt.Sprintf("%s must match exactly one region in %s, found 0. Re-read the file and retry with the current text, including whitespace, newlines, and escaping", label, path)
	}
	lineValues := make([]string, 0, len(matchErr.lines))
	for _, line := range matchErr.lines {
		lineValues = append(lineValues, fmt.Sprintf("%d", line))
		if len(lineValues) == 8 {
			break
		}
	}
	suffix := ""
	if len(matchErr.lines) > len(lineValues) {
		suffix = ", ..."
	}
	return fmt.Sprintf("%s must match exactly one region in %s, found %d at lines [%s%s]. Add surrounding context to oldText", label, path, matchErr.matches, strings.Join(lineValues, ", "), suffix)
}

func applyFSEdits(content string, edits []fsEditItem) (string, error) {
	bom := ""
	matchingContent := content
	if strings.HasPrefix(matchingContent, "\uFEFF") {
		bom = "\uFEFF"
		matchingContent = matchingContent[len(bom):]
	}

	replacements := make([]editReplacement, 0, len(edits))
	for index, edit := range edits {
		if edit.OldText == "" {
			return "", &editInputError{index: index, message: "oldText must not be empty"}
		}
		if edit.OldText == edit.NewText {
			return "", &editInputError{index: index, message: "oldText and newText must differ"}
		}

		matches := findEditMatches(matchingContent, edit.OldText)
		if len(matches) != 1 {
			lines := make([]int, 0, len(matches))
			for _, match := range matches {
				lines = append(lines, editLineNumber(matchingContent, match.start))
			}
			return "", &editMatchError{index: index, matches: len(matches), lines: lines}
		}

		match := matches[0]
		newText := edit.NewText
		if match.fuzzy {
			newText = restoreEditLineEndings(edit.NewText, matchingContent)
		}
		replacements = append(replacements, editReplacement{
			index:   index,
			start:   match.start,
			end:     match.end,
			newText: newText,
		})
	}

	sort.SliceStable(replacements, func(left, right int) bool {
		return replacements[left].start < replacements[right].start
	})
	for index := 1; index < len(replacements); index++ {
		previous := replacements[index-1]
		current := replacements[index]
		if previous.end > current.start {
			return "", &editOverlapError{first: previous.index, second: current.index}
		}
	}

	updated := matchingContent
	for index := len(replacements) - 1; index >= 0; index-- {
		replacement := replacements[index]
		updated = updated[:replacement.start] + replacement.newText + updated[replacement.end:]
	}
	return bom + updated, nil
}
