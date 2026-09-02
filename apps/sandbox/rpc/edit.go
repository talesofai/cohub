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
	index     int
	matches   int
	lines     []int
	truncated bool
}

func (e *editMatchError) Error() string {
	return fmt.Sprintf("edit %d matched %d regions", e.index+1, e.matches)
}

type editInputError struct {
	index   int
	message string
}

func (e *editInputError) Error() string {
	if e.index < 0 {
		return e.message
	}
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
	text string
}

const maxEditMatches = 9

type editOccurrenceSearch struct {
	positions []int
	truncated bool
}

type editMatchSearch struct {
	matches   []editMatch
	truncated bool
}

// normalizeEditText only removes representational differences that are safe to
// repair without changing untouched lines: CRLF/CR line endings and spaces or
// tabs at the end of a line. Match boundaries are mapped back lazily so a
// high-frequency failed search never allocates one entry per source byte.
func normalizeEditText(text string) normalizedEditText {
	var normalized strings.Builder
	normalized.Grow(len(text))

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

		if lineEnd == len(text) {
			break
		}
		newlineEnd := lineEnd + 1
		if text[lineEnd] == '\r' && newlineEnd < len(text) && text[newlineEnd] == '\n' {
			newlineEnd++
		}
		normalized.WriteByte('\n')
		lineStart = newlineEnd
	}

	return normalizedEditText{text: normalized.String()}
}

func findEditOccurrences(text, pattern string) editOccurrenceSearch {
	if pattern == "" {
		return editOccurrenceSearch{}
	}
	occurrences := make([]int, 0, maxEditMatches)
	for cursor := 0; cursor <= len(text)-len(pattern); {
		relative := strings.Index(text[cursor:], pattern)
		if relative < 0 {
			break
		}
		index := cursor + relative
		occurrences = append(occurrences, index)
		if len(occurrences) >= maxEditMatches {
			return editOccurrenceSearch{positions: occurrences, truncated: true}
		}
		cursor = index + len(pattern)
	}
	return editOccurrenceSearch{positions: occurrences}
}

func originalOffsetForNormalizedBoundary(text string, target int) (int, bool) {
	if target < 0 {
		return 0, false
	}
	if len(text) == 0 {
		return 0, target == 0
	}

	normalizedOffset := 0
	for lineStart := 0; lineStart < len(text); {
		lineEnd := lineStart
		for lineEnd < len(text) && text[lineEnd] != '\n' && text[lineEnd] != '\r' {
			lineEnd++
		}

		contentEnd := lineEnd
		for contentEnd > lineStart && (text[contentEnd-1] == ' ' || text[contentEnd-1] == '\t') {
			contentEnd--
		}
		contentLength := contentEnd - lineStart
		if target <= normalizedOffset+contentLength {
			return lineStart + target - normalizedOffset, true
		}
		normalizedOffset += contentLength

		if lineEnd == len(text) {
			return contentEnd, target == normalizedOffset
		}
		newlineEnd := lineEnd + 1
		if text[lineEnd] == '\r' && text[newlineEnd] == '\n' {
			newlineEnd++
		}
		normalizedOffset++
		if target <= normalizedOffset {
			return newlineEnd, true
		}
		lineStart = newlineEnd
	}
	return len(text), target == normalizedOffset
}

func findEditMatches(content, oldText string) editMatchSearch {
	exactOccurrences := findEditOccurrences(content, oldText)
	if len(exactOccurrences.positions) > 0 {
		matches := make([]editMatch, 0, len(exactOccurrences.positions))
		for _, start := range exactOccurrences.positions {
			matches = append(matches, editMatch{start: start, end: start + len(oldText)})
		}
		return editMatchSearch{matches: matches, truncated: exactOccurrences.truncated}
	}

	normalizedContent := normalizeEditText(content)
	normalizedOldText := normalizeEditText(oldText)
	if normalizedOldText.text == "" {
		return editMatchSearch{}
	}
	normalizedOccurrences := findEditOccurrences(normalizedContent.text, normalizedOldText.text)
	matches := make([]editMatch, 0, len(normalizedOccurrences.positions))
	for _, start := range normalizedOccurrences.positions {
		end := start + len(normalizedOldText.text)
		originalStart, startOK := originalOffsetForNormalizedBoundary(content, start)
		originalEnd, endOK := originalOffsetForNormalizedBoundary(content, end)
		if !startOK || !endOK {
			continue
		}
		matches = append(matches, editMatch{start: originalStart, end: originalEnd, fuzzy: true})
	}
	return editMatchSearch{matches: matches, truncated: normalizedOccurrences.truncated}
}

func editLineNumber(content string, offset int) int {
	if offset < 0 {
		offset = 0
	}
	if offset > len(content) {
		offset = len(content)
	}
	line := 1
	for index := 0; index < offset; index++ {
		switch content[index] {
		case '\r':
			line++
			if index+1 < offset && content[index+1] == '\n' {
				index++
			}
		case '\n':
			line++
		}
	}
	return line
}

func editLineEnding(content string) string {
	for index := 0; index < len(content); index++ {
		switch content[index] {
		case '\r':
			if index+1 < len(content) && content[index+1] == '\n' {
				return "\r\n"
			}
			return "\r"
		case '\n':
			return "\n"
		}
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

func collectEditHintCandidates(text string) []string {
	candidates := make([]string, 0, 16)
	add := func(raw string) {
		candidate := strings.TrimSpace(raw)
		runes := []rune(candidate)
		if len(runes) < 4 {
			return
		}
		if len(runes) > 240 {
			candidate = string(runes[:240])
		}
		for _, existing := range candidates {
			if existing == candidate {
				return
			}
		}
		candidates = append(candidates, candidate)
		sort.SliceStable(candidates, func(left, right int) bool { return len(candidates[left]) > len(candidates[right]) })
		if len(candidates) > 16 {
			candidates = candidates[:16]
		}
	}

	var line strings.Builder
	var token strings.Builder
	lineRunes := 0
	tokenRunes := 0
	flushLine := func() {
		add(line.String())
		line.Reset()
		lineRunes = 0
	}
	flushToken := func() {
		add(token.String())
		token.Reset()
		tokenRunes = 0
	}
	for _, char := range text {
		if char == '\n' || char == '\r' {
			flushLine()
			flushToken()
			continue
		}
		if lineRunes < 240 {
			line.WriteRune(char)
			lineRunes++
		}
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || strings.ContainsRune("_./:-", char) {
			if tokenRunes < 240 {
				token.WriteRune(char)
				tokenRunes++
			}
		} else {
			flushToken()
		}
	}
	flushLine()
	flushToken()
	return candidates
}

func editLineBounds(content string, start int) (end int, nextStart int) {
	end = start
	for end < len(content) && content[end] != '\n' && content[end] != '\r' {
		end++
	}
	if end == len(content) {
		return end, end
	}
	nextStart = end + 1
	if content[end] == '\r' && nextStart < len(content) && content[nextStart] == '\n' {
		nextStart++
	}
	return end, nextStart
}

func formatEditHintLine(content string, start, end, lineNumber int) string {
	line := content[start:end]
	runeCount := 0
	for index := range line {
		if runeCount == 240 {
			line = line[:index] + "..."
			break
		}
		runeCount++
	}
	return fmt.Sprintf("%d: %s", lineNumber, line)
}

func editHintBlock(content, oldText string) string {
	oldLines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(oldText, "\r\n", "\n"), "\r", "\n"), "\n")
	candidates := make([]string, 0, len(oldLines)+4)
	for _, line := range oldLines {
		line = strings.TrimSpace(line)
		if len(line) >= 4 {
			candidates = append(candidates, line)
		}
	}
	candidates = append(candidates, collectEditHintCandidates(oldText)...)
	sort.SliceStable(candidates, func(left, right int) bool { return len(candidates[left]) > len(candidates[right]) })
	if len(candidates) > 16 {
		candidates = candidates[:16]
	}
	for _, candidate := range candidates {
		lineStart := 0
		lineNumber := 1
		previousLine := ""
		for lineStart <= len(content) {
			lineEnd, nextStart := editLineBounds(content, lineStart)
			candidateStart := strings.Index(content[lineStart:lineEnd], candidate)
			if candidateStart >= 0 {
				lines := make([]string, 0, 3)
				if previousLine != "" {
					lines = append(lines, previousLine)
				}
				lines = append(lines, formatEditHintLine(content, lineStart, lineEnd, lineNumber))
				if lineEnd < len(content) {
					nextEnd, _ := editLineBounds(content, nextStart)
					lines = append(lines, formatEditHintLine(content, nextStart, nextEnd, lineNumber+1))
				}
				return strings.Join(lines, "\n")
			}
			previousLine = formatEditHintLine(content, lineStart, lineEnd, lineNumber)
			if lineEnd == len(content) {
				break
			}
			lineStart = nextStart
			lineNumber++
		}
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
	if matchErr.truncated || len(matchErr.lines) > len(lineValues) {
		suffix = ", ..."
	}
	count := fmt.Sprintf("%d", matchErr.matches)
	if matchErr.truncated {
		count += "+"
	}
	return fmt.Sprintf("%s must match exactly one region in %s, found %s at lines [%s%s]. Add surrounding context to oldText", label, path, count, strings.Join(lineValues, ", "), suffix)
}

func applyFSEdits(content string, edits []fsEditItem) (string, error) {
	if len(edits) == 0 {
		return "", &editInputError{index: -1, message: "edits must contain at least one replacement"}
	}
	bom := ""
	matchingContent := content
	if strings.HasPrefix(matchingContent, "\uFEFF") {
		bom = "\uFEFF"
		matchingContent = matchingContent[len(bom):]
	}

	replacements := make([]editReplacement, 0, len(edits))
	for index, edit := range edits {
		oldText := strings.TrimPrefix(edit.OldText, "\uFEFF")
		if oldText == "" {
			return "", &editInputError{index: index, message: "oldText must not be empty"}
		}
		if oldText == edit.NewText {
			return "", &editInputError{index: index, message: "oldText and newText must differ"}
		}

		search := findEditMatches(matchingContent, oldText)
		if len(search.matches) != 1 {
			lines := make([]int, 0, len(search.matches))
			for _, match := range search.matches {
				lines = append(lines, editLineNumber(matchingContent, match.start))
			}
			return "", &editMatchError{index: index, matches: len(search.matches), lines: lines, truncated: search.truncated}
		}

		match := search.matches[0]
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
