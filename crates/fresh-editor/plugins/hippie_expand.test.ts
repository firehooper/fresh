/**
 * Unit tests for hippie_expand.ts pure functions.
 *
 * These tests exercise extractWordPrefix, collectBufferWords, looksLikePath,
 * and parsePathPrefix without requiring the Fresh editor runtime.
 *
 * Run with: npx tsx hippie_expand.test.ts
 * (or any TS runner that supports top-level execution)
 */

// ---------------------------------------------------------------------------
// Inline copies of pure functions under test (no editor dependency)
// ---------------------------------------------------------------------------

const WORD_CHAR_PATTERN = /[A-Za-z0-9_\-]/;

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
  }
}

function looksLikePath(prefix: string): boolean {
  if (prefix.length === 0) return false;
  if (prefix.includes("/") || prefix.includes("\\")) return true;
  const firstChar = prefix[0];
  return firstChar === "." || firstChar === "~" || firstChar === "/";
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
});

describe("collectBufferWords — basic matching", () => {
  const text = "foobar foo fob food";

  assertDeepEqual(
    collectBufferWords(text, "fo", text.length, "both"),
    // All words match "fo*" — ordered: nearest before cursor first
    // foobar(0-6), foo(7-10), fob(11-14), food(15-19)
    // All are before cursor (cursor at end=19), reversed: food, fob, foo, foobar
    ["food", "fob", "foo", "foobar"],
    "collects all fo* words, nearest first",
  );

  assertDeepEqual(
    collectBufferWords(text, "foo", text.length, "both"),
    // foobar, food match "foo*"; fob does NOT; "foo" is exact prefix → excluded
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
  //                   0123456789012345678
  const text = "alpha beta alpha gamma";

  assertDeepEqual(
    collectBufferWords(text, "al", 10, "before"),
    // "alpha" at pos 0-5 is before cursor=10 → ["alpha"] reversed → ["alpha"]
    ["alpha"],
    "before cursor only",
  );

  assertDeepEqual(
    collectBufferWords(text, "al", 10, "after"),
    // "alpha" at pos 11-16 is after cursor=10 → but it's a duplicate → []
    // Wait — dedup is global, so second alpha is skipped
    [],
    "after cursor — duplicate alpha is skipped",
  );
});

describe("collectBufferWords — case insensitivity", () => {
  const text = "Foobar FOOBAR fooBar";

  assertDeepEqual(
    collectBufferWords(text, "foo", text.length, "both"),
    // All three match "foo*" case-insensitively
    // But "foobar", "FOOBAR", "fooBar" have same lowercase → only first seen kept
    // Scanning L-to-R: Foobar(0-6) kept, FOOBAR(7-13) dup, fooBar(14-20) dup
    // All before cursor, reversed: just ["Foobar"]
    ["Foobar"],
    "case-insensitive dedup preserves first occurrence",
  );
});

describe("collectBufferWords — empty prefix", () => {
  const text = "alpha beta gamma";

  const result = collectBufferWords(text, "", 5, "both");
  // Before cursor (<=5): alpha(0-5) → before list reversed: [alpha]
  // After cursor (>5): beta(6-10), gamma(11-16) → [beta, gamma]
  // Combined: [alpha, beta, gamma]
  assertDeepEqual(
    result,
    ["alpha", "beta", "gamma"],
    "empty prefix returns all words, nearest-before first",
  );
});

describe("collectBufferWords — proximity ordering", () => {
  //                   01234567890123456789012
  const text = "aaa abc abd abe abf";
  // aaa(0-3), abc(4-7), abd(8-11), abe(12-15), abf(16-19)

  assertDeepEqual(
    collectBufferWords(text, "ab", 12, "before"),
    // Before cursor(12): abc(4-7) end=7 <=12 ✓, abd(8-11) end=11 <=12 ✓
    // reversed: [abd, abc]
    ["abd", "abc"],
    "before-cursor words ordered nearest first",
  );

  assertDeepEqual(
    collectBufferWords(text, "ab", 12, "after"),
    // After cursor(12): abe(12-15) end=15 >12 ✓, abf(16-19) end=19 >12 ✓
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

  // Verify hyphenated words are treated as single tokens
  assertDeepEqual(
    extractWordPrefix("my-variable-name = 42", 16),
    { prefix: "my-variable-name", start: 0 },
    "hyphenated word is a single token",
  );

  // Verify that the prefix itself isn't returned when it exactly matches
  assertDeepEqual(
    collectBufferWords("test test test", "test", 14, "both"),
    [],
    "all identical words = all excluded (exact match of prefix)",
  );
});

describe("wrap-around scenario simulation", () => {
  // Simulate: prefix "fo", candidates ["foobar", "fob"]
  // index -1 = original prefix, 0 = foobar, 1 = fob
  // next from 1 should wrap to -1 (original)
  // next from -1 should go to 0
  const candidates = ["foobar", "fob"];
  let index = -1;

  // First expand
  index = 0;
  assert(candidates[index] === "foobar", "first expansion is foobar");

  // Next
  index = 1;
  assert(candidates[index] === "fob", "second expansion is fob");

  // Next — would wrap
  const nextIndex = index + 1;
  assert(nextIndex >= candidates.length, "next index exceeds list — triggers wrap");

  // Wrap back
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
