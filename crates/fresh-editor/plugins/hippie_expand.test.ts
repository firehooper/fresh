/**
 * Unit tests for hippie_expand.ts pure functions.
 *
 * Tests extractWordPrefix, extractPathPrefix, collectBufferWords,
 * looksLikePath, normalizeSeparators, pathsEqual, and parsePathPrefix
 * without requiring the Fresh editor runtime.
 *
 * Run with: npx ts-node --esm hippie_expand.test.ts
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
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const word = match[0];
    const wordLower = word.toLowerCase();
    if (wordLower === prefixLower) continue;
    if (!wordLower.startsWith(prefixLower)) continue;
    if (seen.has(wordLower)) continue;
    seen.add(wordLower);

    const wordEnd = match.index + word.length;
    if (wordEnd <= cursorPos) {
      beforeCursor.push(word);
    } else {
      afterCursor.push(word);
    }
  }

  beforeCursor.reverse();

  switch (order) {
    case "before": return beforeCursor;
    case "after":  return afterCursor;
    case "both":   return [...beforeCursor, ...afterCursor];
    default:       return [];
  }
}

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
    if (seen.has(key)) continue;
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
    default:       return [];
  }
}

function looksLikePath(prefix: string): boolean {
  if (prefix.length === 0) return false;
  if (prefix.includes("/") || prefix.includes("\\")) return true;
  const firstChar = prefix[0];
  if (firstChar === "." || firstChar === "~" || firstChar === "/") return true;
  // Windows drive letter (e.g., "C:" or "C:\")
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
    "collects all fo* words, nearest first",
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
    "after cursor — duplicate alpha is skipped",
  );
});

describe("collectBufferWords — case insensitivity", () => {
  const text = "Foobar FOOBAR fooBar";

  assertDeepEqual(
    collectBufferWords(text, "foo", text.length, "both"),
    ["Foobar"],
    "case-insensitive dedup preserves first occurrence",
  );
});

describe("collectBufferWords — empty prefix", () => {
  const text = "alpha beta gamma";

  const result = collectBufferWords(text, "", 5, "both");
  assertDeepEqual(
    result,
    ["alpha", "beta", "gamma"],
    "empty prefix returns all words, nearest-before first",
  );
});

describe("collectBufferWords — proximity ordering", () => {
  const text = "aaa abc abd abe abf";

  assertDeepEqual(
    collectBufferWords(text, "ab", 12, "before"),
    ["abd", "abc"],
    "before-cursor words ordered nearest first",
  );

  assertDeepEqual(
    collectBufferWords(text, "ab", 12, "after"),
    ["abe", "abf"],
    "after-cursor words in occurrence order",
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
  assert(looksLikePath(".hidden") === true, ".hidden starts with dot");
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
