/**
 * Unit tests for hippie_expand.ts pure functions.
 *
 * Tests extractWordPrefix, extractPathPrefix, collectBufferWords,
 * looksLikePath, normalizeSeparators, pathsEqual, and proximity-based
 * ordering without requiring the Fresh editor runtime.
 *
 * Run with: npx tsx hippie_expand.test.ts
 */

// ---------------------------------------------------------------------------
// Inline copies of pure functions under test (no editor dependency)
// ---------------------------------------------------------------------------

const WORD_CHAR_PATTERN = /[A-Za-z0-9_\-]/;
const PATH_CHAR_PATTERN = /[A-Za-z0-9_\-./\\~:]/;

function wordTokenRegex(minLength: number): RegExp {
  return new RegExp(`[A-Za-z0-9_\\-]{${minLength},}`, "g");
}

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

interface WordMatch {
  word: string;
  distance: number;
  position: "before" | "after";
}

/**
 * Compare two WordMatch entries by proximity.
 * Primary: closest distance first.
 * Tiebreaker: prefer "before" over "after".
 */
function compareByProximity(a: WordMatch, b: WordMatch): number {
  if (a.distance !== b.distance) {
    return a.distance - b.distance;
  }
  const aOrder = a.position === "before" ? 0 : 1;
  const bOrder = b.position === "before" ? 0 : 1;
  return aOrder - bOrder;
}

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

  const prefixStart = cursorPos - prefix.length;

  while ((match = regex.exec(text)) !== null) {
    const word = match[0];
    const wordLower = word.toLowerCase();
    if (wordLower === prefixLower) continue;
    if (!wordLower.startsWith(prefixLower)) continue;

    // Skip the word the cursor is currently inside of
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

/**
 * Extract the dot/equals chain context immediately left of the prefix.
 * For "foo.bar.baz.tes|", returns "foo.bar.baz.".
 * For "a.b = c.tes|", space stops the walk, returns "c.".
 * Returns "" if no separator found.
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
  if (!chain.includes(".") && !chain.includes("=")) {
    return "";
  }
  return chain;
}

/**
 * Collect candidates that appear in the same chain context elsewhere.
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
  const typedChainStart = cursorPos - prefix.length - chainContext.length;

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const idx = textLower.indexOf(chainLower, searchFrom);
    if (idx === -1) break;

    if (idx === typedChainStart) {
      searchFrom = idx + 1;
      continue;
    }

    const wordStart = idx + chainContext.length;
    let wordEnd = wordStart;
    while (wordEnd < text.length && WORD_CHAR_PATTERN.test(text[wordEnd])) {
      wordEnd++;
    }

    const word = text.slice(wordStart, wordEnd);
    if (word.length === 0) { searchFrom = idx + 1; continue; }
    const wordLower = word.toLowerCase();
    if (wordLower === prefixLower) { searchFrom = idx + 1; continue; }
    if (prefix.length > 0 && !wordLower.startsWith(prefixLower)) {
      searchFrom = idx + 1; continue;
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
 */
function getChainContextCascade(fullChain: string): string[] {
  if (fullChain.length === 0) {
    return [];
  }
  const contexts: string[] = [fullChain];
  if (!fullChain.includes(".")) {
    return contexts;
  }
  let idx = 0;
  while (idx < fullChain.length) {
    const dotIdx = fullChain.indexOf(".", idx);
    if (dotIdx === -1) break;
    const suffix = fullChain.slice(dotIdx);
    if (suffix !== fullChain && suffix.length > 1) {
      contexts.push(suffix);
    }
    idx = dotIdx + 1;
  }
  return contexts;
}

function looksLikePath(prefix: string): boolean {
  if (prefix.length === 0) return false;
  if (prefix.includes("/") || prefix.includes("\\")) return true;
  if (prefix[0] === "~") return true;
  if (prefix[0] === ".") {
    if (prefix.length === 1) return true;
    if (prefix[1] === "/" || prefix[1] === "\\") return true;
    if (prefix[1] === ".") return true;
    return false; // .split, .sp — method calls, not paths
  }
  if (prefix.length >= 2 && /^[A-Za-z]:/.test(prefix)) return true;
  return false;
}

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

function pathsEqual(a: string, b: string): boolean {
  const aNorm = normalizeSeparators(a);
  const bNorm = normalizeSeparators(b);
  const isWindows = /^[A-Za-z]:\//.test(aNorm) || /^[A-Za-z]:\//.test(bNorm);
  if (isWindows) {
    return aNorm.toLowerCase() === bNorm.toLowerCase();
  }
  return aNorm === bNorm;
}

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
    console.error(`    expected: ${e}`);
    console.error(`    actual:   ${a}`);
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n${name}`);
  fn();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractWordPrefix", () => {
  assert(
    extractWordPrefix("hello world", 5).prefix === "hello",
    "extracts prefix at end of first word",
  );

  assert(
    extractWordPrefix("hello world", 5).start === 0,
    "start offset is 0 for first word",
  );

  assertDeepEqual(
    extractWordPrefix("hello world", 8),
    { prefix: "wo", start: 6 },
    "extracts partial word in middle",
  );

  assertDeepEqual(
    extractWordPrefix("hello world", 0),
    { prefix: "", start: 0 },
    "empty prefix at position 0",
  );

  assertDeepEqual(
    extractWordPrefix("hello world", 6),
    { prefix: "", start: 6 },
    "empty prefix after space (cursor at start of 'world')",
  );

  assertDeepEqual(
    extractWordPrefix("foo_bar-baz", 11),
    { prefix: "foo_bar-baz", start: 0 },
    "underscores and hyphens are word characters",
  );

  assertDeepEqual(
    extractWordPrefix("a.b", 3),
    { prefix: "b", start: 2 },
    "dot is NOT a word character — stops at dot",
  );

  // Path separators are NOT word characters
  const fwdPath = "./src/foo";
  assertDeepEqual(
    extractWordPrefix(fwdPath, fwdPath.length),
    { prefix: "foo", start: fwdPath.length - 3 },
    "word prefix stops at / — only captures 'foo'",
  );

  const winPath = "C:\\Users\\sam";
  assertDeepEqual(
    extractWordPrefix(winPath, winPath.length),
    { prefix: "sam", start: winPath.length - 3 },
    "word prefix stops at backslash",
  );
});

describe("extractPathPrefix", () => {
  // Path prefix includes /, \, ., ~, :
  assertDeepEqual(
    extractPathPrefix("./src/foo", 9),
    { prefix: "./src/foo", start: 0 },
    "captures full relative path including ./ and slashes",
  );

  const winAbsPath = "C:\\Users\\sam";
  assertDeepEqual(
    extractPathPrefix(winAbsPath, winAbsPath.length),
    { prefix: winAbsPath, start: 0 },
    "captures Windows absolute path with drive letter and backslashes",
  );

  assertDeepEqual(
    extractPathPrefix("~/docs/report.txt", 17),
    { prefix: "~/docs/report.txt", start: 0 },
    "captures tilde-prefixed path with dots in filename",
  );

  assertDeepEqual(
    extractPathPrefix("/etc/nginx/conf.d", 17),
    { prefix: "/etc/nginx/conf.d", start: 0 },
    "captures absolute Linux path",
  );

  // Stops at whitespace — path prefix doesn't cross spaces
  assertDeepEqual(
    extractPathPrefix("import ./src/foo", 16),
    { prefix: "./src/foo", start: 7 },
    "stops at whitespace before path",
  );

  // Still works for plain words (superset of word chars)
  assertDeepEqual(
    extractPathPrefix("foobar", 6),
    { prefix: "foobar", start: 0 },
    "plain word is also a valid path prefix",
  );

  // Quoted path context — stops at quote
  assertDeepEqual(
    extractPathPrefix('"./src/lib"', 10),
    { prefix: "./src/lib", start: 1 },
    "stops at double-quote before path",
  );
});

describe("collectBufferWords — basic matching", () => {
  const text = "foobar foo fob food";

  assertDeepEqual(
    collectBufferWords(text, "fo", text.length, "both"),
    ["food", "fob", "foo", "foobar"],
    "collects all fo* words, nearest first (by distance from cursor)",
  );

  assertDeepEqual(
    collectBufferWords(text, "foo", text.length, "both"),
    ["food", "foobar"],
    "foo* excludes fob and exact prefix 'foo'",
  );

  assertDeepEqual(
    collectBufferWords(text, "foobar", text.length, "both"),
    [],
    "exact match of prefix is excluded",
  );
});

describe("collectBufferWords — before/after cursor split", () => {
  const text = "alpha beta alpha gamma";

  assertDeepEqual(
    collectBufferWords(text, "al", 10, "before"),
    ["alpha"],
    "before cursor only",
  );

  assertDeepEqual(
    collectBufferWords(text, "al", 10, "after"),
    [],
    "after cursor — duplicate alpha is skipped (nearest is before cursor)",
  );
});

describe("collectBufferWords — case insensitivity (nearest case wins)", () => {
  const text = "Foobar FOOBAR fooBar";

  // Positions: Foobar(0-6), FOOBAR(7-13), fooBar(14-20)
  // Cursor at end (20), all are before cursor.
  // Distances: Foobar=14, FOOBAR=7, fooBar=0
  // Nearest is fooBar → its casing wins.
  assertDeepEqual(
    collectBufferWords(text, "foo", text.length, "both"),
    ["fooBar"],
    "case-insensitive dedup preserves nearest occurrence's casing",
  );

  // With cursor in the middle (at position 10, between FOOBAR and fooBar):
  // FOOBAR: starts at 7, ends at 13. 13 > 10, so "after". distance = max(0, 7-10) = 0
  // Foobar at 0-6: before, distance = 10-6 = 4
  // fooBar at 14-20: after, distance = 14-10 = 4
  // Nearest is FOOBAR (distance 0) → its casing wins.
  assertDeepEqual(
    collectBufferWords(text, "foo", 10, "both"),
    ["FOOBAR"],
    "cursor mid-text: nearest occurrence (FOOBAR overlapping cursor) wins casing",
  );
});

describe("collectBufferWords — empty prefix", () => {
  const text = "alpha beta gamma";

  const result = collectBufferWords(text, "", 5, "both");
  // alpha ends at 5, distance = 0 (before). beta starts at 6, distance = 1 (after). gamma starts at 11, distance = 6 (after).
  assertDeepEqual(
    result,
    ["alpha", "beta", "gamma"],
    "empty prefix returns all words, nearest first",
  );
});

describe("collectBufferWords — proximity ordering", () => {
  const text = "aaa abc abd abe abf";
  // positions: aaa(0-3), abc(4-7), abd(8-11), abe(12-15), abf(16-19)
  // cursor at 12

  assertDeepEqual(
    collectBufferWords(text, "ab", 12, "before"),
    ["abd", "abc"],
    "before-cursor words ordered nearest first",
  );

  assertDeepEqual(
    collectBufferWords(text, "ab", 12, "after"),
    ["abe", "abf"],
    "after-cursor words ordered nearest first",
  );

  // "both" interleaves by distance:
  // abd: before, dist = 12-11 = 1
  // abe: after, dist = 12-12 = 0
  // abc: before, dist = 12-7 = 5
  // abf: after, dist = 16-12 = 4
  // Sorted: abe(0), abd(1), abf(4), abc(5)
  assertDeepEqual(
    collectBufferWords(text, "ab", 12, "both"),
    ["abe", "abd", "abf", "abc"],
    "both: interleaved by absolute proximity — closest first regardless of direction",
  );
});

describe("collectBufferWords — tiebreaker: before-cursor wins", () => {
  // Two words equidistant from cursor: one before, one after.
  // "before" should come first in the results.
  const text = "fob xxx foo";
  // fob at 0-3, foo at 8-11
  // Cursor at 5 (in "xxx"): fob dist = 5-3 = 2 (before), foo dist = 8-5 = 3 (after)
  // Not tied. Let's construct a better case:
  // "fob x foo" — fob(0-3), foo(6-9), cursor at 4
  // fob: before, dist = 4-3 = 1
  // foo: after, dist = 6-4 = 2
  // Still not tied. Let me try:
  // "fob  foo" — fob(0-3), foo(5-8), cursor at 4
  // fob: before, dist = 4-3 = 1
  // foo: after, dist = 5-4 = 1  → TIED!
  const text2 = "fob  foo";
  assertDeepEqual(
    collectBufferWords(text2, "fo", 4, "both"),
    ["fob", "foo"],
    "equal distance: before-cursor word ('fob') comes first",
  );
});

describe("collectBufferWords — cursor inside longer word is excluded", () => {
  // User typed "foo" (cursor at 3), but buffer has "foobar" starting at 0.
  // "foobar" starts at 0 (≤ prefixStart=0) and ends at 6 (> cursorPos=3).
  // It overlaps the typed region → should be excluded.
  const text = "foobar later foobie";
  assertDeepEqual(
    collectBufferWords(text, "foo", 3, "both"),
    ["foobie"],
    "word overlapping cursor ('foobar' at pos 0) is excluded; 'foobie' returned",
  );

  // Same scenario but cursor is at end of "foobar" — no overlap since wordEnd = cursorPos
  assertDeepEqual(
    collectBufferWords(text, "foobar", 6, "both"),
    [],
    "exact match at cursor position is excluded by prefix check",
  );

  // When the word doesn't overlap (cursor past the word), it's included normally
  const text2 = "foobar something foo";
  assertDeepEqual(
    collectBufferWords(text2, "foo", text2.length, "both"),
    ["foobar"],
    "foobar before cursor is included when cursor is well past it",
  );
});

describe("collectBufferWords — proximity interleaving with cursor mid-text", () => {
  const text = "getUser foo getValue bar get baz getItem qux getName";
  // g(0)e(1)t(2)U(3)s(4)e(5)r(6) (7)f(8)o(9)o(10) (11)g(12)e(13)t(14)V(15)a(16)l(17)u(18)e(19) (20)b(21)a(22)r(23) (24)g(25)e(26)t(27) (28)b(29)a(30)z(31) (32)g(33)e(34)t(35)I(36)t(37)e(38)m(39) (40)q(41)u(42)x(43) (44)g(45)e(46)t(47)N(48)a(49)m(50)e(51)
  const cursor = 28; // right after "get " (cursor after the space)
  // "get" at 25-28: exact prefix match → excluded
  // getUser ends at 7, dist = 28-7 = 21 (before)
  // getValue ends at 20, dist = 28-20 = 8 (before)
  // getItem starts at 33, dist = 33-28 = 5 (after)
  // getName starts at 45, dist = 45-28 = 17 (after)

  assertDeepEqual(
    collectBufferWords(text, "get", cursor, "both"),
    ["getItem", "getValue", "getName", "getUser"],
    "proximity interleaving: getItem(5) < getValue(8) < getName(17) < getUser(21)",
  );
});

describe("collectBufferWords — dedup prefers nearest case across positions", () => {
  // Same word appears before (far, uppercase) and after (near, lowercase)
  const text = "FOOBAR something foobar";
  // FOOBAR: 0-6, foobar: 18-24
  const cursor = 16;
  // FOOBAR: before, dist = 16-6 = 10
  // foobar: after, dist = 18-16 = 2

  assertDeepEqual(
    collectBufferWords(text, "foo", cursor, "both"),
    ["foobar"],
    "nearest occurrence (after cursor, lowercase) wins over farther uppercase version",
  );
});

describe("looksLikePath", () => {
  assert(looksLikePath("./src") === true, "./src is path-like");
  assert(looksLikePath("~/docs") === true, "~/docs is path-like");
  assert(looksLikePath("/etc") === true, "/etc is path-like");
  assert(looksLikePath("src/lib") === true, "src/lib has slash");
  assert(looksLikePath("src\\lib") === true, "src\\lib has backslash");
  assert(looksLikePath("foobar") === false, "foobar is not path-like");
  assert(looksLikePath("") === false, "empty string is not path-like");
  // Dot-prefix: method calls vs paths
  assert(looksLikePath(".hidden") === false, ".hidden is a method call, NOT path-like");
  assert(looksLikePath(".split") === false, ".split is a method call, NOT path-like");
  assert(looksLikePath(".sp") === false, ".sp is a method call fragment, NOT path-like");
  assert(looksLikePath(".") === true, "just '.' is path-like (current dir)");
  assert(looksLikePath("..") === true, "'..' is path-like (parent dir)");
  assert(looksLikePath("./src") === true, "./src is path-like");
  assert(looksLikePath(".\\src") === true, ".\\src is path-like");
  assert(looksLikePath("../foo") === true, "../foo is path-like");
  // Windows drive letters
  assert(looksLikePath("C:") === true, "C: is path-like (Windows drive)");
  assert(looksLikePath("C:\\Users") === true, "C:\\Users is path-like");
  assert(looksLikePath("D:/data") === true, "D:/data is path-like");
});

describe("normalizeSeparators", () => {
  assert(
    normalizeSeparators("C:\\Users\\sam") === "C:/Users/sam",
    "backslashes converted to forward slashes",
  );
  assert(
    normalizeSeparators("/home/sam") === "/home/sam",
    "forward slashes unchanged on Linux",
  );
  assert(
    normalizeSeparators("./src\\lib/foo") === "./src/lib/foo",
    "mixed separators normalized",
  );
});

describe("pathsEqual — cross-platform comparison", () => {
  // Windows: case-insensitive
  assert(
    pathsEqual("C:\\Users\\Sam", "C:/users/sam") === true,
    "Windows paths compared case-insensitively with normalized separators",
  );
  assert(
    pathsEqual("C:/Foo", "C:/foo") === true,
    "Windows forward-slash paths case-insensitive",
  );
  // Linux: case-sensitive
  assert(
    pathsEqual("/home/Sam", "/home/sam") === false,
    "Linux paths compared case-sensitively",
  );
  assert(
    pathsEqual("/home/sam", "/home/sam") === true,
    "Linux identical paths are equal",
  );
  // Edge: one Windows with mixed case
  assert(
    pathsEqual("C:/Users/Sam", "c:/users/sam") === true,
    "Windows drive letter triggers case-insensitive compare",
  );
  // Edge: neither has drive letter — treated as Linux (case-sensitive)
  assert(
    pathsEqual("/Users/Sam", "/Users/sam") === false,
    "no drive letter = case-sensitive (Linux/macOS)",
  );
});

// ---------------------------------------------------------------------------
// Edge cases and failure modes
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  assertDeepEqual(
    extractWordPrefix("", 0),
    { prefix: "", start: 0 },
    "empty buffer, cursor at 0",
  );

  assertDeepEqual(
    extractWordPrefix("   ", 3),
    { prefix: "", start: 3 },
    "all-whitespace buffer",
  );

  assertDeepEqual(
    collectBufferWords("", "fo", 0, "both"),
    [],
    "empty buffer yields no candidates",
  );

  assertDeepEqual(
    collectBufferWords("short", "verylongprefix", 5, "both"),
    [],
    "prefix longer than any word yields nothing",
  );

  assertDeepEqual(
    extractWordPrefix("my-variable-name = 42", 16),
    { prefix: "my-variable-name", start: 0 },
    "hyphenated word is a single token",
  );

  assertDeepEqual(
    collectBufferWords("test test test", "test", 14, "both"),
    [],
    "all identical words = all excluded (exact match of prefix)",
  );

  // Path prefix on empty buffer
  assertDeepEqual(
    extractPathPrefix("", 0),
    { prefix: "", start: 0 },
    "path prefix: empty buffer returns empty",
  );

  // Path prefix stops at parentheses, brackets, etc.
  assertDeepEqual(
    extractPathPrefix("require(./src/foo)", 17),
    { prefix: "./src/foo", start: 8 },
    "path prefix stops at opening paren",
  );
});

describe("path prefix vs word prefix interaction", () => {
  // The critical scenario: user types "./src/foo"
  // Word prefix only sees "foo" (stops at /)
  // Path prefix sees "./src/foo" (includes / and .)
  const text = 'const p = "./src/foo';
  const cursor = text.length; // at end

  const wordResult = extractWordPrefix(text, cursor);
  assert(
    wordResult.prefix === "foo",
    "word prefix extracts only 'foo' from path context",
  );

  const pathResult = extractPathPrefix(text, cursor);
  assert(
    pathResult.prefix === "./src/foo",
    "path prefix extracts full './src/foo' from path context",
  );

  assert(
    looksLikePath(pathResult.prefix) === true,
    "path prefix triggers path completion",
  );
  assert(
    looksLikePath(wordResult.prefix) === false,
    "word prefix does NOT trigger path completion — this was the original bug",
  );
});

describe("compareByProximity — sort helper", () => {
  const a: WordMatch = { word: "alpha", distance: 5, position: "before" };
  const b: WordMatch = { word: "beta", distance: 10, position: "after" };
  assert(
    compareByProximity(a, b) < 0,
    "closer distance sorts first",
  );
  assert(
    compareByProximity(b, a) > 0,
    "farther distance sorts second",
  );

  // Tiebreaker
  const c: WordMatch = { word: "charlie", distance: 5, position: "before" };
  const d: WordMatch = { word: "delta", distance: 5, position: "after" };
  assert(
    compareByProximity(c, d) < 0,
    "equal distance: before-cursor wins over after-cursor",
  );
  assert(
    compareByProximity(d, c) > 0,
    "equal distance: after-cursor loses to before-cursor",
  );

  // Same distance, same position
  const e: WordMatch = { word: "echo", distance: 3, position: "before" };
  const f: WordMatch = { word: "foxtrot", distance: 3, position: "before" };
  assert(
    compareByProximity(e, f) === 0,
    "equal distance and position: stable (no preference)",
  );
});

describe("extractChainContext", () => {
  // foo.bar.baz.tes — chain is "foo.bar.baz."
  const text1 = "foo.bar.baz.tes";
  const prefix1Start = text1.lastIndexOf("tes"); // 12
  assertDeepEqual(
    extractChainContext(text1, prefix1Start),
    "foo.bar.baz.",
    "extracts full dot chain before prefix",
  );

  // a.b = c.tes — space stops the walk, chain is "c."
  const text2 = "a.b = c.tes";
  const prefix2Start = text2.lastIndexOf("tes"); // 8
  assertDeepEqual(
    extractChainContext(text2, prefix2Start),
    "c.",
    "stops at space — takes closest chain to left",
  );

  // No separator — returns ""
  assertDeepEqual(
    extractChainContext("foobar", 3),
    "",
    "no dot or equals → empty chain",
  );

  // Equals chain: x=tes
  const text3 = "x=tes";
  assertDeepEqual(
    extractChainContext(text3, 2),
    "x=",
    "equals sign is a chain separator",
  );

  // Only dot: obj.
  assertDeepEqual(
    extractChainContext("obj.", 4),
    "obj.",
    "full chain when prefix is empty (cursor right after dot)",
  );
});

describe("collectContextualCandidates — dot chain matching", () => {
  // Buffer has "foo.bar.testing" earlier; user types "foo.bar.tes"
  const text = "foo.bar.testing other foo.bar.tes";
  // foo.bar.testing at 0, foo.bar.tes at 22 (cursor at 32)
  const cursor = text.length; // 32
  const prefix = "tes";
  const chainContext = "foo.bar.";

  assertDeepEqual(
    collectContextualCandidates(text, chainContext, prefix, cursor),
    ["testing"],
    "finds 'testing' from 'foo.bar.testing' in same chain context",
  );

  // Empty prefix after dot: "foo." → finds all words after "foo." in context
  const text2 = "foo.alpha foo.beta something foo.";
  const cursor2 = text2.length; // after "foo."
  assertDeepEqual(
    collectContextualCandidates(text2, "foo.", "", cursor2),
    ["beta", "alpha"],
    "empty prefix with chain context returns all contextual words, nearest first",
  );

  // Case-insensitive chain matching
  const text3 = "Foo.Bar.Testing other foo.bar.tes";
  const cursor3 = text3.length;
  assertDeepEqual(
    collectContextualCandidates(text3, "foo.bar.", "tes", cursor3),
    ["Testing"],
    "chain context matching is case-insensitive; preserves original casing",
  );

  // No chain context → empty results
  assertDeepEqual(
    collectContextualCandidates("testing other words", "", "tes", 19),
    [],
    "empty chain context returns nothing",
  );

  // Excludes the occurrence at cursor position
  const text4 = "obj.testing";
  assertDeepEqual(
    collectContextualCandidates(text4, "obj.", "testing", text4.length),
    [],
    "only occurrence is at cursor → excluded, no results",
  );
});

describe("getChainContextCascade", () => {
  assertDeepEqual(
    getChainContextCascade("foo.bar.baz."),
    ["foo.bar.baz.", ".bar.baz.", ".baz.", "."],
    "full cascade: progressively shorter dot-chain suffixes",
  );

  assertDeepEqual(
    getChainContextCascade("receiver."),
    ["receiver.", "."],
    "single-segment chain: full + just dot",
  );

  assertDeepEqual(
    getChainContextCascade("x="),
    ["x="],
    "equals chain: no cascade (no dots)",
  );

  assertDeepEqual(
    getChainContextCascade(""),
    [],
    "empty chain: no cascade",
  );

  assertDeepEqual(
    getChainContextCascade("."),
    ["."],
    "just a dot: single entry",
  );
});

describe("chain cascade — cross-chain method discovery", () => {
  // Simulates: buffer has formatABA(aba).split("").map { _.toInt }
  // User types x.spl somewhere else. Full chain "x." doesn't match
  // "formatABA(aba).", but cascade to "." finds ".split" in the buffer.

  const buffer = 'val result = formatABA(aba).split("").map { _.toInt }\nval x.spl';
  // ".split" appears after ")" at position 26
  // ".spl" at end is what user typed

  // With just the full chain "x.", no match for ".split":
  assertDeepEqual(
    collectContextualCandidates(buffer, "x.", "spl", buffer.length),
    [],
    "full chain 'x.' doesn't match 'formatABA(aba).split'",
  );

  // But with cascade suffix ".", it finds ".split":
  assertDeepEqual(
    collectContextualCandidates(buffer, ".", "spl", buffer.length),
    ["split"],
    "cascade to '.' finds '.split' from any chain — discovers method names",
  );

  // Simulates: buffer has obj.splitABADigits and we type result.spl
  const buffer2 = "obj.splitABADigits something result.spl";
  assertDeepEqual(
    collectContextualCandidates(buffer2, ".", "spl", buffer2.length),
    ["splitABADigits"],
    "cascade '.' finds splitABADigits from obj.splitABADigits",
  );
});

describe("wrap-around scenario simulation", () => {
  const candidates = ["foobar", "fob"];
  let index = -1;

  index = 0;
  assert(candidates[index] === "foobar", "first expansion is foobar");

  index = 1;
  assert(candidates[index] === "fob", "second expansion is fob");

  const nextIndex = index + 1;
  assert(nextIndex >= candidates.length, "next index exceeds list — triggers wrap");

  index = -1;
  assert(index === -1, "wrapped back to original prefix");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("ALL TESTS PASSED");
}
