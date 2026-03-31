/// <reference path="./lib/fresh.d.ts" />

/**
 * Hippie Expand Plugin — Lexical (dumb) word completion without LSP
 *
 * Inspired by Emacs hippie-expand (M-/) and Vim C-x C-n.
 * Scans current buffer, other open buffers, and filesystem paths
 * to autocomplete the word-prefix at the cursor.
 *
 * Sources (tried in priority order):
 *   1. Current buffer — words before cursor (nearest first)
 *   2. Current buffer — words after cursor
 *   3. Other open (non-virtual) buffers
 *   4. File paths — when prefix looks path-like
 *
 * Keybinding: user must bind Alt+/ to "hippie_expand_next" in config.
 * Once cycling begins, the plugin enters "hippie-cycling" mode which
 * captures Alt+/, Alt+Shift+/, and Escape. Any cursor movement exits.
 */

const editor = getEditor();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum bytes to read from a single buffer (perf guard) */
const BUFFER_READ_LIMIT = 500 * 1024; // 500KB

/** Maximum candidates to collect before stopping (perf guard) */
const MAX_CANDIDATES = 50;

/** Regex character class for "word" characters */
const WORD_CHAR_PATTERN = /[A-Za-z0-9_\-]/;

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

// ---------------------------------------------------------------------------
// §6.2  Candidate Collection — Buffer Words
// ---------------------------------------------------------------------------

/**
 * Extract unique words from `text` that match `prefix` (case-insensitive).
 * Returns them ordered by proximity to `cursorPos`:
 *   - Words before cursor: nearest first (reversed occurrence order)
 *   - Words after cursor: nearest first (occurrence order)
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
  const beforeCursor: string[] = [];
  const afterCursor: string[] = [];
  const seen = new Set<string>(); // lowercase dedup key
  let match: RegExpExecArray | null;

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

    // Deduplicate (case-insensitive key, but preserve original case)
    if (seen.has(wordLower)) {
      continue;
    }
    seen.add(wordLower);

    const wordEnd = match.index + word.length;
    if (wordEnd <= cursorPos) {
      beforeCursor.push(word);
    } else {
      afterCursor.push(word);
    }
  }

  // Before-cursor: nearest to cursor first → reverse
  beforeCursor.reverse();

  switch (order) {
    case "before": return beforeCursor;
    case "after":  return afterCursor;
    case "both":   return [...beforeCursor, ...afterCursor];
  }
}

/**
 * When prefix is empty, return all distinct words near the cursor.
 * Useful for "expand first word" when cursor is at column 0 or after whitespace.
 */
function collectFirstWords(
  text: string,
  cursorPos: number,
  order: "before" | "after" | "both",
): string[] {
  const regex = wordTokenRegex(1);
  const before: string[] = [];
  const after: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const word = match[0];
    const key = word.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (match.index + word.length <= cursorPos) {
      before.push(word);
    } else {
      after.push(word);
    }
  }

  before.reverse();

  switch (order) {
    case "before": return before;
    case "after":  return after;
    case "both":   return [...before, ...after];
  }
}

// ---------------------------------------------------------------------------
// §6.2  Candidate Collection — All Sources
// ---------------------------------------------------------------------------

/**
 * Collect candidates from all sources in priority order.
 * Stops early once MAX_CANDIDATES are found (perf guard for many open buffers).
 */
async function collectAllCandidates(
  prefix: string,
  activeBufferId: number,
  cursorPos: number,
): Promise<string[]> {
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

  // --- Source 1 & 2: Current buffer (before then after cursor) ---
  const currentText = await readBufferCapped(activeBufferId);
  if (currentText !== null) {
    const beforeWords = collectBufferWords(currentText, prefix, cursorPos, "before");
    appendUnique(beforeWords);

    const afterWords = collectBufferWords(currentText, prefix, cursorPos, "after");
    appendUnique(afterWords);
  }

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

  // --- Source 4: File path completions (if prefix looks path-like) ---
  if (allCandidates.length < MAX_CANDIDATES && looksLikePath(prefix)) {
    const pathCandidates = collectPathCandidates(prefix);
    appendUnique(pathCandidates);
  }

  return allCandidates;
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
 * Triggers when it contains `/`, or starts with `.`, `~`, or `/`.
 */
function looksLikePath(prefix: string): boolean {
  if (prefix.length === 0) {
    return false;
  }
  if (prefix.includes("/") || prefix.includes("\\")) {
    return true;
  }
  const firstChar = prefix[0];
  return firstChar === "." || firstChar === "~" || firstChar === "/";
}

/**
 * Collect filesystem path completions for a path-like prefix.
 * Reuses the same parsing approach as path_complete.ts.
 */
function collectPathCandidates(prefix: string): string[] {
  const { dir, pattern } = parsePathPrefix(prefix);
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
      const fullPath = buildFullPath(dir, entry.name) + suffix;
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
 * Similar to path_complete.ts parsePath but works with word-prefix context.
 */
function parsePathPrefix(input: string): { dir: string; pattern: string } {
  const lastSlash = Math.max(input.lastIndexOf("/"), input.lastIndexOf("\\"));

  if (lastSlash === -1) {
    // No slash — treat prefix as pattern in cwd
    return { dir: editor.getCwd(), pattern: input };
  }

  const dir = input.slice(0, lastSlash) || "/";
  const pattern = input.slice(lastSlash + 1);

  // Resolve relative paths against cwd
  if (!editor.pathIsAbsolute(dir)) {
    return { dir: editor.pathJoin(editor.getCwd(), dir), pattern };
  }

  return { dir, pattern };
}

/** Build a display path from dir + filename, keeping it relative when possible. */
function buildFullPath(dir: string, name: string): string {
  const cwd = editor.getCwd();
  const absolute = editor.pathJoin(dir, name);

  // If the dir was cwd, return just the name
  if (dir === cwd || dir === ".") {
    return name;
  }

  return absolute;
}

// ---------------------------------------------------------------------------
// §6.3  Expansion Application
// ---------------------------------------------------------------------------

/**
 * Replace the current prefix/completion region with the given candidate.
 * The region is [state.prefixStart .. state.prefixStart + lastInserted.length].
 *
 * If any editor mutation fails, we exit cycling mode to avoid state corruption.
 */
function applyExpansion(candidate: string): void {
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

/** Show cycling status in the status bar. */
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

  const candidates = await collectAllCandidates(prefix, bufferId, cursorPos);

  if (candidates.length === 0) {
    editor.setStatus(editor.t("status.no_candidates"));
    return;
  }

  // Initialize cycling state
  state = {
    active: true,
    prefix: prefix,
    prefixStart: start,
    candidates: candidates,
    index: 0,
    lastInserted: prefix, // currently the prefix is in the buffer
    previousMode: null,
  };

  // Insert first candidate
  applyExpansion(candidates[0]);
  enterCyclingMode();
  showCyclingStatus();
}

// ---------------------------------------------------------------------------
// Cursor Movement Detection — Exit Cycling
// ---------------------------------------------------------------------------

/**
 * When the user moves the cursor to an unexpected position while cycling,
 * commit the current expansion and exit cycling mode.
 */
function hippie_on_cursor_moved(): void {
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
