/// <reference path="./lib/fresh.d.ts" />

/**
 * Hippie Expand Plugin — Lexical (dumb) word completion without LSP
 *
 * Inspired by Emacs hippie-expand (M-/) and Vim C-x C-n.
 * Scans current buffer, other open buffers, and filesystem paths
 * to autocomplete the word-prefix at the cursor.
 *
 * Sources (tried in priority order):
 *   0. Chain-context matches — when cursor is at "foo.bar.tes|", finds
 *      "foo.bar.testing" elsewhere and prioritizes "testing"
 *   1. Current buffer — words sorted by absolute proximity to cursor
 *      (closest word first, whether before or after the cursor)
 *   2. Other open (non-virtual) buffers
 *   3. File paths — when prefix looks path-like
 *
 * Matching is case-insensitive on the prefix side, but completions
 * preserve the original casing of the matched word in the buffer.
 * When the same word appears multiple times with different casing,
 * the occurrence nearest to the cursor wins.
 *
 * Keybinding: user must bind Alt+/ to "hippie_expand_next" in config.
 * Once cycling begins, the plugin enters "hippie-cycling" mode which
 * captures Alt+/, Alt+Shift+/, and Escape. Any cursor movement exits.
 *
 * Cross-platform: path handling normalizes separators via editor.pathJoin()
 * which always uses forward slashes. Both / and \ are recognized in input.
 */

const editor = getEditor();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum bytes to read from a single buffer (perf guard) */
const BUFFER_READ_LIMIT = 500 * 1024; // 500KB

/** Maximum candidates to collect before stopping (perf guard) */
const MAX_CANDIDATES = 50;

/** Regex character class for "word" characters (identifiers) */
const WORD_CHAR_PATTERN = /[A-Za-z0-9_\-]/;

/**
 * Regex character class for "path" characters.
 * Includes word chars plus separators, dots, tildes, colons (Windows drive).
 * Used only for the path-aware prefix extraction.
 */
const PATH_CHAR_PATTERN = /[A-Za-z0-9_\-./\\~:]/;

/** Regex for extracting word tokens from buffer text.
 *  Minimum length is set dynamically based on prefix length. */
function wordTokenRegex(minLength: number): RegExp {
  // {minLength,} ensures we only match words at least as long as the prefix
  return new RegExp(`[A-Za-z0-9_\\-]{${minLength},}`, "g");
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface HippieState {
  active: boolean;         // Are we in cycling mode?
  prefix: string;          // Original typed prefix (what the user had before expansion)
  prefixStart: number;     // Byte offset where the prefix begins in the buffer
  candidates: string[];    // All collected candidates (deduplicated, ordered)
  index: number;           // Current candidate index (-1 = showing original prefix)
  lastInserted: string;    // What we last put in — used to verify cursor hasn't drifted
  previousMode: string | null; // Editor mode before we entered hippie-cycling
}

function makeIdleState(): HippieState {
  return {
    active: false,
    prefix: "",
    prefixStart: 0,
    candidates: [],
    index: -1,
    lastInserted: "",
    previousMode: null,
  };
}

let state: HippieState = makeIdleState();

/**
 * Guard flag: suppresses cursor_moved checks while we are programmatically
 * editing the buffer in applyExpansion(). Without this, the deleteRange +
 * insertText + setBufferCursor calls can fire cursor_moved events that
 * prematurely exit cycling mode.
 */
let suppressCursorCheck = false;

// ---------------------------------------------------------------------------
// Cross-platform path utilities
// ---------------------------------------------------------------------------

/** Normalize path separators to forward slashes for consistent comparison. */
function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Case-insensitive path comparison on Windows, case-sensitive on Linux/macOS.
 * Uses a simple heuristic: if either path contains a drive letter (C:),
 * assume Windows and compare case-insensitively.
 */
function pathsEqual(a: string, b: string): boolean {
  const aNorm = normalizeSeparators(a);
  const bNorm = normalizeSeparators(b);
  // Heuristic: drive letter pattern like "C:/" indicates Windows
  const isWindows = /^[A-Za-z]:\//.test(aNorm) || /^[A-Za-z]:\//.test(bNorm);
  if (isWindows) {
    return aNorm.toLowerCase() === bNorm.toLowerCase();
  }
  return aNorm === bNorm;
}

// ---------------------------------------------------------------------------
// §6.1  Word Prefix Extraction
// ---------------------------------------------------------------------------

/**
 * Walk backwards from `cursorPos` collecting word characters.
 * Returns the prefix string and the byte offset where it starts.
 *
 * Edge cases:
 *   - cursor at column 0 or after whitespace → empty prefix
 *   - Only ASCII word chars considered (Fresh API is byte-based)
 */
function extractWordPrefix(
  bufferText: string,
  cursorPos: number,
): { prefix: string; start: number } {
  let start = cursorPos;
  while (start > 0 && WORD_CHAR_PATTERN.test(bufferText[start - 1])) {
    start--;
  }
  const prefix = bufferText.slice(start, cursorPos);
  return { prefix, start };
}

/**
 * Walk backwards from `cursorPos` collecting path-like characters.
 * Includes /, \, ., ~, : (Windows drive letters) in addition to word chars.
 * Used when we suspect the user is typing a file path.
 *
 * This is a separate extraction because path chars (slashes, dots) would
 * break normal word completion if included in the default pattern.
 */
function extractPathPrefix(
  bufferText: string,
  cursorPos: number,
): { prefix: string; start: number } {
  let start = cursorPos;
  while (start > 0 && PATH_CHAR_PATTERN.test(bufferText[start - 1])) {
    start--;
  }
  const prefix = bufferText.slice(start, cursorPos);
  return { prefix, start };
}

// ---------------------------------------------------------------------------
// §6.2  Candidate Collection — Buffer Words
// ---------------------------------------------------------------------------

/** A word match with its distance from the cursor for proximity sorting. */
interface WordMatch {
  word: string;
  distance: number;
  /** "before" = word ends at or before cursor; "after" = word starts at or after cursor. */
  position: "before" | "after";
}

/**
 * Compare two WordMatch entries by proximity.
 * Primary: closest distance first.
 * Tiebreaker: prefer "before" over "after" — you're more likely to want
 * to reuse a word you recently typed above the cursor.
 */
function compareByProximity(a: WordMatch, b: WordMatch): number {
  if (a.distance !== b.distance) {
    return a.distance - b.distance;
  }
  // Tiebreak: before-cursor wins (0 < 1)
  const aOrder = a.position === "before" ? 0 : 1;
  const bOrder = b.position === "before" ? 0 : 1;
  return aOrder - bOrder;
}

/**
 * Extract unique words from `text` that match `prefix` (case-insensitive).
 * Returns them ordered by absolute proximity to `cursorPos` — the closest
 * word wins regardless of whether it appears before or after the cursor.
 *
 * Deduplication is case-insensitive, but the **nearest** occurrence's
 * casing is preserved. For example, if "FooBar" is far and "fooBar" is
 * near the cursor, "fooBar" is the one returned.
 *
 * The exact `prefix` itself is excluded from results.
 */
function collectBufferWords(
  text: string,
  prefix: string,
  cursorPos: number,
  order: "before" | "after" | "both",
): string[] {
  if (prefix.length === 0) {
    return collectFirstWords(text, cursorPos, order);
  }

  const regex = wordTokenRegex(prefix.length);
  const prefixLower = prefix.toLowerCase();
  const matchesByKey = new Map<string, WordMatch>();
  let match: RegExpExecArray | null;

  // prefixStart = cursorPos - prefix.length (for overlap detection)
  const prefixStart = cursorPos - prefix.length;

  while ((match = regex.exec(text)) !== null) {
    const word = match[0];
    const wordLower = word.toLowerCase();

    // Skip the exact typed prefix
    if (wordLower === prefixLower) {
      continue;
    }

    // Must start with the prefix (case-insensitive)
    if (!wordLower.startsWith(prefixLower)) {
      continue;
    }

    // Skip the word the cursor is currently inside of.
    // A match that starts at or before prefixStart and ends past cursorPos
    // is the very word being typed — offering it back is not useful.
    const wordEnd = match.index + word.length;
    if (match.index <= prefixStart && wordEnd > cursorPos) {
      continue;
    }

    let distance: number;
    let position: "before" | "after";

    if (wordEnd <= cursorPos) {
      distance = cursorPos - wordEnd;
      position = "before";
    } else {
      distance = match.index >= cursorPos ? match.index - cursorPos : 0;
      position = "after";
    }

    // Deduplicate: keep the occurrence nearest to cursor (preserves its casing)
    const existing = matchesByKey.get(wordLower);
    if (!existing || distance < existing.distance) {
      matchesByKey.set(wordLower, { word, distance, position });
    }
  }

  const allMatches = Array.from(matchesByKey.values());

  switch (order) {
    case "before":
      return allMatches
        .filter((m) => m.position === "before")
        .sort(compareByProximity)
        .map((m) => m.word);
    case "after":
      return allMatches
        .filter((m) => m.position === "after")
        .sort(compareByProximity)
        .map((m) => m.word);
    case "both":
      return allMatches
        .sort(compareByProximity)
        .map((m) => m.word);
    default:
      return [];
  }
}

/**
 * When prefix is empty, return all distinct words near the cursor.
 * Useful for "expand first word" when cursor is at column 0 or after whitespace.
 *
 * Same proximity/dedup rules as collectBufferWords: sorted by absolute
 * distance from cursor, nearest occurrence's casing wins.
 */
function collectFirstWords(
  text: string,
  cursorPos: number,
  order: "before" | "after" | "both",
): string[] {
  const regex = wordTokenRegex(1);
  const matchesByKey = new Map<string, WordMatch>();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const word = match[0];
    const key = word.toLowerCase();

    const wordEnd = match.index + word.length;
    let distance: number;
    let position: "before" | "after";

    if (wordEnd <= cursorPos) {
      distance = cursorPos - wordEnd;
      position = "before";
    } else {
      distance = match.index >= cursorPos ? match.index - cursorPos : 0;
      position = "after";
    }

    const existing = matchesByKey.get(key);
    if (!existing || distance < existing.distance) {
      matchesByKey.set(key, { word, distance, position });
    }
  }

  const allMatches = Array.from(matchesByKey.values());

  switch (order) {
    case "before":
      return allMatches
        .filter((m) => m.position === "before")
        .sort(compareByProximity)
        .map((m) => m.word);
    case "after":
      return allMatches
        .filter((m) => m.position === "after")
        .sort(compareByProximity)
        .map((m) => m.word);
    case "both":
      return allMatches
        .sort(compareByProximity)
        .map((m) => m.word);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// §6.2b Candidate Collection — Chain Context (dot/equals chains)
// ---------------------------------------------------------------------------

/**
 * Extract the dot/equals chain context immediately left of the prefix.
 *
 * For "foo.bar.baz.tes|", prefixStart points at "tes", so we walk left
 * collecting word chars, dots, and equals signs. Returns "foo.bar.baz.".
 *
 * For "a.b = c.tes|", space stops the walk, so we get "c." — taking
 * the closest chain to the left as the user expects.
 *
 * Returns "" if no chain separator (. or =) is found.
 */
function extractChainContext(
  bufferText: string,
  prefixStart: number,
): string {
  let start = prefixStart;
  while (start > 0) {
    const ch = bufferText[start - 1];
    if (WORD_CHAR_PATTERN.test(ch) || ch === "." || ch === "=") {
      start--;
    } else {
      break;
    }
  }
  const chain = bufferText.slice(start, prefixStart);
  // Only meaningful if it contains at least one separator
  if (!chain.includes(".") && !chain.includes("=")) {
    return "";
  }
  return chain;
}

/**
 * Collect candidates that appear in the same chain context elsewhere in
 * the buffer. For example, if the cursor is at "foo.bar.tes|" and the
 * buffer contains "foo.bar.testing", returns ["testing"].
 *
 * Search is case-insensitive. Results are proximity-sorted.
 * The occurrence at the cursor position itself is excluded.
 */
function collectContextualCandidates(
  text: string,
  chainContext: string,
  prefix: string,
  cursorPos: number,
): string[] {
  if (chainContext.length === 0) {
    return [];
  }

  const chainLower = chainContext.toLowerCase();
  const prefixLower = prefix.toLowerCase();
  const textLower = text.toLowerCase();
  const results = new Map<string, WordMatch>();

  // The start of the typed chain in the buffer (to exclude the cursor occurrence)
  const typedChainStart = cursorPos - prefix.length - chainContext.length;

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const idx = textLower.indexOf(chainLower, searchFrom);
    if (idx === -1) {
      break;
    }

    // Skip the occurrence at our cursor position
    if (idx === typedChainStart) {
      searchFrom = idx + 1;
      continue;
    }

    // Extract the word that follows the chain context
    const wordStart = idx + chainContext.length;
    let wordEnd = wordStart;
    while (wordEnd < text.length && WORD_CHAR_PATTERN.test(text[wordEnd])) {
      wordEnd++;
    }

    const word = text.slice(wordStart, wordEnd);
    if (word.length === 0) {
      searchFrom = idx + 1;
      continue;
    }

    const wordLower = word.toLowerCase();

    // Skip exact prefix match
    if (wordLower === prefixLower) {
      searchFrom = idx + 1;
      continue;
    }

    // Must match prefix if prefix is non-empty
    if (prefix.length > 0 && !wordLower.startsWith(prefixLower)) {
      searchFrom = idx + 1;
      continue;
    }

    let distance: number;
    let position: "before" | "after";
    if (wordEnd <= cursorPos) {
      distance = cursorPos - wordEnd;
      position = "before";
    } else {
      distance = wordStart >= cursorPos ? wordStart - cursorPos : 0;
      position = "after";
    }

    const existing = results.get(wordLower);
    if (!existing || distance < existing.distance) {
      results.set(wordLower, { word, distance, position });
    }

    searchFrom = idx + 1;
  }

  const allMatches = Array.from(results.values());
  allMatches.sort(compareByProximity);
  return allMatches.map((m) => m.word);
}

/**
 * Generate progressively shorter chain context suffixes for cascaded matching.
 *
 * For "foo.bar.baz.", returns:
 *   ["foo.bar.baz.", "bar.baz.", "baz."]
 *
 * This allows matching even when the full chain differs. For example,
 * the buffer has `formatABA(aba).split("")` and user types `x.spl` — the
 * full chain "x." won't match "formatABA(aba).", but the cascade also
 * tries just "." which finds `.split` in any method chain.
 *
 * For "=" chains, no cascade (already minimal).
 */
function getChainContextCascade(fullChain: string): string[] {
  if (fullChain.length === 0) {
    return [];
  }

  const contexts: string[] = [fullChain];

  // Only cascade dot-chains (not = or mixed)
  if (!fullChain.includes(".")) {
    return contexts;
  }

  // Generate shorter suffixes by removing leading "word." segments
  let idx = 0;
  while (idx < fullChain.length) {
    const dotIdx = fullChain.indexOf(".", idx);
    if (dotIdx === -1) {
      break;
    }
    // Suffix starts at this dot, e.g., ".baz." from "foo.bar.baz."
    const suffix = fullChain.slice(dotIdx);
    if (suffix !== fullChain && suffix.length > 1) {
      contexts.push(suffix);
    }
    idx = dotIdx + 1;
  }

  return contexts;
}

// ---------------------------------------------------------------------------
// §6.2  Candidate Collection — All Sources
// ---------------------------------------------------------------------------

/**
 * Collect candidates from all sources in priority order.
 * Stops early once MAX_CANDIDATES are found (perf guard for many open buffers).
 *
 * Priority order:
 *   0. Chain-context matches — cascaded from most specific to least:
 *      "foo.bar.baz." → "bar.baz." → "baz." → then just "."-based
 *   1. Current buffer words (proximity-sorted)
 *   2. Other open buffers
 *   3. File paths (when prefix looks path-like)
 */
async function collectAllCandidates(
  prefix: string,
  prefixStart: number,
  activeBufferId: number,
  cursorPos: number,
  bufferText: string,
): Promise<{ candidates: string[]; usedPrefix: string; usedStart: number }> {
  const allCandidates: string[] = [];
  const seenLower = new Set<string>();

  /** Append `words` to allCandidates, deduplicating globally. */
  function appendUnique(words: string[]): void {
    for (const w of words) {
      if (allCandidates.length >= MAX_CANDIDATES) {
        return;
      }
      const key = w.toLowerCase();
      if (!seenLower.has(key)) {
        seenLower.add(key);
        allCandidates.push(w);
      }
    }
  }

  // Check if the broader path-prefix context looks path-like.
  // We do this by re-extracting with path chars and checking the result.
  const pathExtraction = extractPathPrefix(bufferText, cursorPos);
  const isPathContext = looksLikePath(pathExtraction.prefix);

  if (isPathContext) {
    // --- Source 3 first: File path completions ---
    // Use the wider path-prefix (includes /, \, ., ~, :)
    const pathCandidates = collectPathCandidates(pathExtraction.prefix);
    appendUnique(pathCandidates);

    // Return the path prefix info so applyExpansion replaces the right region
    return {
      candidates: allCandidates,
      usedPrefix: pathExtraction.prefix,
      usedStart: pathExtraction.start,
    };
  }

  // --- Source 0: Chain-context matches (highest priority, cascaded) ---
  // Try the full chain first ("foo.bar.baz."), then shorter suffixes
  // ("bar.baz.", "baz.", ".") to find method/property patterns from
  // other chains in the buffer (e.g., .split from formatABA(aba).split).
  const chainContext = extractChainContext(bufferText, prefixStart);
  if (chainContext.length > 0) {
    const cascade = getChainContextCascade(chainContext);
    for (const ctx of cascade) {
      if (allCandidates.length >= MAX_CANDIDATES) {
        break;
      }
      const contextual = collectContextualCandidates(
        bufferText, ctx, prefix, cursorPos,
      );
      appendUnique(contextual);
    }
  }

  // --- Source 1: Current buffer words (interleaved by proximity) ---
  const currentWords = collectBufferWords(bufferText, prefix, cursorPos, "both");
  appendUnique(currentWords);

  // --- Source 3: Other open (non-virtual) buffers ---
  if (allCandidates.length < MAX_CANDIDATES) {
    const buffers = editor.listBuffers();
    for (const buf of buffers) {
      if (buf.id === activeBufferId) {
        continue;
      }
      if (buf.is_virtual) {
        continue;
      }
      if (allCandidates.length >= MAX_CANDIDATES) {
        break;
      }
      const text = await readBufferCapped(buf.id);
      if (text !== null) {
        const words = collectBufferWords(text, prefix, 0, "both");
        appendUnique(words);
      }
    }
  }

  return {
    candidates: allCandidates,
    usedPrefix: prefix,
    usedStart: prefixStart,
  };
}

// ---------------------------------------------------------------------------
// Buffer Reading (capped for performance)
// ---------------------------------------------------------------------------

/**
 * Read buffer text up to BUFFER_READ_LIMIT bytes.
 * Returns null if the buffer cannot be read.
 */
async function readBufferCapped(bufferId: number): Promise<string | null> {
  try {
    const length = editor.getBufferLength(bufferId);
    const readEnd = Math.min(length, BUFFER_READ_LIMIT);
    const text = await editor.getBufferText(bufferId, 0, readEnd);
    return text;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// §Source 4: File Path Completion
// ---------------------------------------------------------------------------

/**
 * Heuristic: does this prefix look like a filesystem path?
 * Triggers when it contains a separator, starts with ~, or has a drive letter.
 *
 * Dot-prefix is only path-like when followed by / or \ (e.g., ./src, ../foo)
 * or is just "." or "..".  ".split" or ".sp" are method calls, not paths.
 */
function looksLikePath(prefix: string): boolean {
  if (prefix.length === 0) {
    return false;
  }
  // Contains a path separator
  if (prefix.includes("/") || prefix.includes("\\")) {
    return true;
  }
  // Tilde: home directory shorthand (~/docs)
  if (prefix[0] === "~") {
    return true;
  }
  // Dot-prefix: only path-like if followed by / or \ (like ./src, ..\foo)
  // or is just "." or ".." (current/parent dir).
  // NOT ".split", ".sp", ".hidden-method" — those are method/property calls.
  if (prefix[0] === ".") {
    if (prefix.length === 1) {
      return true; // just "."
    }
    if (prefix[1] === "/" || prefix[1] === "\\") {
      return true; // ./src, .\src
    }
    if (prefix[1] === ".") {
      return true; // ../foo, ..
    }
    return false; // .split, .sp — method calls
  }
  // Windows drive letter (e.g., "C:" or "C:\")
  if (prefix.length >= 2 && /^[A-Za-z]:/.test(prefix)) {
    return true;
  }
  return false;
}

/**
 * Collect filesystem path completions for a path-like prefix.
 * Reuses the same parsing approach as path_complete.ts.
 */
function collectPathCandidates(prefix: string): string[] {
  const { dir, pattern, inputDir } = parsePathPrefix(prefix);
  const entries = editor.readDir(dir);
  if (!entries) {
    return [];
  }

  const patternLower = pattern.toLowerCase();
  const results: string[] = [];

  for (const entry of entries) {
    // Skip hidden files unless pattern explicitly starts with '.'
    if (entry.name.startsWith(".") && !pattern.startsWith(".")) {
      continue;
    }

    if (entry.name.toLowerCase().startsWith(patternLower)) {
      const suffix = entry.is_dir ? "/" : "";
      // Reconstruct the path using the user's original dir prefix
      // so the inserted text matches what they typed (relative vs absolute)
      const fullPath = rebuildUserPath(inputDir, entry.name) + suffix;
      results.push(fullPath);
    }

    if (results.length >= MAX_CANDIDATES) {
      break;
    }
  }

  return results;
}

/**
 * Parse a path prefix into its directory and trailing pattern components.
 * Returns:
 *   - dir: resolved absolute directory for readDir()
 *   - pattern: trailing filename fragment to match against
 *   - inputDir: the directory portion as the user typed it (for reconstruction)
 *
 * Handles both / and \ separators for cross-platform support.
 */
function parsePathPrefix(
  input: string,
): { dir: string; pattern: string; inputDir: string } {
  const lastSlash = Math.max(input.lastIndexOf("/"), input.lastIndexOf("\\"));

  if (lastSlash === -1) {
    // No slash — treat prefix as pattern in cwd
    return { dir: editor.getCwd(), pattern: input, inputDir: "" };
  }

  const inputDir = input.slice(0, lastSlash + 1); // include the trailing slash
  const pattern = input.slice(lastSlash + 1);
  const dirPath = input.slice(0, lastSlash) || "/";

  // Resolve relative paths against cwd
  if (!editor.pathIsAbsolute(dirPath)) {
    const resolved = editor.pathJoin(editor.getCwd(), dirPath);
    return { dir: resolved, pattern, inputDir };
  }

  return { dir: dirPath, pattern, inputDir };
}

/**
 * Rebuild the display path using the user's original directory prefix.
 * This preserves their style (relative vs absolute, / vs \).
 */
function rebuildUserPath(inputDir: string, name: string): string {
  // If inputDir is empty, the user didn't type a directory — just return the name
  if (inputDir === "") {
    return name;
  }
  return inputDir + name;
}

// ---------------------------------------------------------------------------
// §6.3  Expansion Application
// ---------------------------------------------------------------------------

/**
 * Replace the current prefix/completion region with the given candidate.
 * The region is [state.prefixStart .. state.prefixStart + lastInserted.length].
 *
 * Sets suppressCursorCheck to avoid the cursor_moved handler exiting
 * cycling mode during our own programmatic edits.
 *
 * If any editor mutation fails, we exit cycling mode to avoid state corruption.
 */
function applyExpansion(candidate: string): void {
  suppressCursorCheck = true;
  try {
    const bufferId = editor.getActiveBufferId();
    const deleteEnd = state.prefixStart + editor.utf8ByteLength(state.lastInserted);

    editor.deleteRange(bufferId, state.prefixStart, deleteEnd);
    editor.insertText(bufferId, state.prefixStart, candidate);

    // Move cursor to end of inserted text
    const newCursorPos = state.prefixStart + editor.utf8ByteLength(candidate);
    editor.setBufferCursor(bufferId, newCursorPos);

    state.lastInserted = candidate;
  } catch {
    editor.setStatus(editor.t("status.error"));
    exitCyclingMode();
  } finally {
    suppressCursorCheck = false;
  }
}

// ---------------------------------------------------------------------------
// §6.3  Cycling State Machine
// ---------------------------------------------------------------------------

/**
 * Activate cycling mode: save previous editor mode,
 * switch to "hippie-cycling" so Alt+/ and Escape are captured.
 */
function enterCyclingMode(): void {
  state.previousMode = editor.getEditorMode();
  editor.setEditorMode("hippie-cycling");
}

/** Exit cycling mode: restore previous editor mode and reset state. */
function exitCyclingMode(): void {
  const restoreMode = state.previousMode;
  state = makeIdleState();
  if (restoreMode !== null) {
    editor.setEditorMode(restoreMode);
  } else {
    // Fall back to clearing the mode (returns to default)
    editor.setEditorMode(null);
  }
}

/** Show cycling status in the status bar, including the matched prefix for context. */
function showCyclingStatus(): void {
  if (state.index < 0) {
    editor.setStatus(editor.t("status.no_more"));
    return;
  }

  const total = state.candidates.length;
  const word = state.candidates[state.index];
  editor.setStatus(
    editor.t("status.cycling", {
      index: String(state.index + 1),
      total: String(total),
      word: word,
      prefix: state.prefix,
    }),
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * hippie_expand_next — Expand or cycle forward.
 *
 * First invocation: extract prefix, collect candidates, insert first match.
 * Subsequent invocations (while cycling): advance to next candidate.
 * Wraps around when the list is exhausted (includes original prefix at end).
 */
async function hippie_expand_next(): Promise<void> {
  if (!state.active) {
    await startExpansion();
    return;
  }

  // Already cycling — advance index
  const nextIndex = state.index + 1;

  if (nextIndex >= state.candidates.length) {
    // Wrap: restore original prefix
    applyExpansion(state.prefix);
    state.index = -1;
    editor.setStatus(editor.t("status.wrapping"));
    return;
  }

  state.index = nextIndex;
  applyExpansion(state.candidates[state.index]);
  showCyclingStatus();
}
registerHandler("hippie_expand_next", hippie_expand_next);

/**
 * hippie_expand_prev — Cycle backward through candidates.
 */
function hippie_expand_prev(): void {
  if (!state.active) {
    return; // Nothing to cycle backward through
  }

  const prevIndex = state.index - 1;

  if (prevIndex < -1) {
    // Wrap backward: go to last candidate
    state.index = state.candidates.length - 1;
    applyExpansion(state.candidates[state.index]);
    showCyclingStatus();
    return;
  }

  if (prevIndex === -1) {
    // Restore original prefix
    applyExpansion(state.prefix);
    state.index = -1;
    editor.setStatus(editor.t("status.original"));
    return;
  }

  state.index = prevIndex;
  applyExpansion(state.candidates[state.index]);
  showCyclingStatus();
}
registerHandler("hippie_expand_prev", hippie_expand_prev);

/**
 * hippie_expand_abort — Cancel expansion and restore original prefix.
 */
function hippie_expand_abort(): void {
  if (!state.active) {
    return;
  }

  applyExpansion(state.prefix);
  editor.setStatus(editor.t("status.aborted"));
  exitCyclingMode();
}
registerHandler("hippie_expand_abort", hippie_expand_abort);

// ---------------------------------------------------------------------------
// First Expansion
// ---------------------------------------------------------------------------

/**
 * Start a new expansion: extract prefix, collect candidates, insert first.
 * If no candidates found, show a status message and do nothing.
 *
 * Performs two-phase prefix extraction:
 *   1. Standard word prefix (for buffer word sources)
 *   2. Extended path prefix (for filesystem source, includes / \ . ~ :)
 * collectAllCandidates decides which prefix to use based on context.
 */
async function startExpansion(): Promise<void> {
  const bufferId = editor.getActiveBufferId();
  const cursorPos = editor.getCursorPosition();
  const bufferText = await readBufferCapped(bufferId);

  if (bufferText === null) {
    editor.setStatus(editor.t("status.error"));
    return;
  }

  const { prefix, start } = extractWordPrefix(bufferText, cursorPos);

  const result = await collectAllCandidates(
    prefix, start, bufferId, cursorPos, bufferText,
  );

  if (result.candidates.length === 0) {
    editor.setStatus(editor.t("status.no_candidates"));
    return;
  }

  // Initialize cycling state.
  // Use the prefix/start that collectAllCandidates actually matched against,
  // which may be the wider path prefix if we're in a path context.
  state = {
    active: true,
    prefix: result.usedPrefix,
    prefixStart: result.usedStart,
    candidates: result.candidates,
    index: 0,
    lastInserted: result.usedPrefix, // currently in the buffer
    previousMode: null,
  };

  // Insert first candidate
  applyExpansion(result.candidates[0]);
  enterCyclingMode();
  showCyclingStatus();
}

// ---------------------------------------------------------------------------
// Cursor Movement Detection — Exit Cycling
// ---------------------------------------------------------------------------

/**
 * When the user moves the cursor to an unexpected position while cycling,
 * commit the current expansion and exit cycling mode.
 *
 * Guarded by suppressCursorCheck so our own programmatic edits in
 * applyExpansion() don't trigger a premature exit.
 */
function hippie_on_cursor_moved(): void {
  if (suppressCursorCheck) {
    return;
  }
  if (!state.active) {
    return;
  }

  const cursorPos = editor.getCursorPosition();
  const expectedPos = state.prefixStart + editor.utf8ByteLength(state.lastInserted);

  if (cursorPos !== expectedPos) {
    // User moved away — commit current expansion silently
    exitCyclingMode();
  }
}
registerHandler("hippie_on_cursor_moved", hippie_on_cursor_moved);

editor.on("cursor_moved", "hippie_on_cursor_moved");

// ---------------------------------------------------------------------------
// Mode & Command Registration
// ---------------------------------------------------------------------------

// Define the cycling mode — only active while user is cycling through candidates.
// All unmapped keys will cause the mode to be exited via cursor_moved detection.
editor.defineMode("hippie-cycling", [
  ["Alt+/",       "hippie_expand_next"],
  ["Alt+Shift+/", "hippie_expand_prev"],
  ["Escape",      "hippie_expand_abort"],
]);

// Register commands so they appear in the command palette and can be bound
editor.registerCommand(
  "Hippie Expand: Next",
  editor.t("command.next_desc"),
  "hippie_expand_next",
);

editor.registerCommand(
  "Hippie Expand: Previous",
  editor.t("command.prev_desc"),
  "hippie_expand_prev",
);

editor.registerCommand(
  "Hippie Expand: Abort",
  editor.t("command.abort_desc"),
  "hippie_expand_abort",
);

editor.setStatus(editor.t("status.loaded"));
