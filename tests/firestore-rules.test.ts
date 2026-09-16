import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards against the quietest possible production failure: adding a new
 * Firestore collection and forgetting to grant access to it. Firestore denies
 * anything a rule does not match, so the app would simply stop saving, with no
 * error the user ever sees.
 */

const ROOT = join(import.meta.dir, '..');

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry) && !full.includes('/tests/')) acc.push(full);
  }
  return acc;
}

/**
 * Extracts the collection names from every doc() and collection() call.
 * A Firestore path alternates collection, document, collection, document, so
 * the literals in even positions are the collections.
 */
export function collectionPathsInSource(source: string): string[][] {
  const paths: string[][] = [];
  const call = /\b(?:doc|collection)\(\s*db\s*,([^)]*)\)/g;

  for (const match of source.matchAll(call)) {
    const args = match[1].split(',').map((a) => a.trim());
    const segments: string[] = [];
    args.forEach((arg, index) => {
      if (index % 2 !== 0) return; // odd positions are document ids
      const literal = arg.match(/^['"]([^'"]+)['"]$/);
      if (literal) segments.push(literal[1]);
    });
    if (segments.length > 0) paths.push(segments);
  }
  return paths;
}

const RULES = readFileSync(join(ROOT, 'firestore.rules'), 'utf8');

describe('firestore.rules covers every collection the app touches', () => {
  const found = new Set<string>();
  for (const file of sourceFiles(ROOT)) {
    for (const path of collectionPathsInSource(readFileSync(file, 'utf8'))) {
      found.add(path.join('/'));
    }
  }

  test('the scan actually finds the collections in use', () => {
    // A scanner that silently finds nothing would make every check below pass.
    expect(found.size).toBeGreaterThan(0);
    expect([...found].some((p) => p.startsWith('users'))).toBe(true);
  });

  test('every collection in the code has a matching rule', () => {
    const uncovered: string[] = [];
    for (const path of found) {
      for (const collection of path.split('/')) {
        if (!new RegExp(`match\\s+/${collection}/\\{`).test(RULES)) {
          uncovered.push(`${collection} (from path ${path})`);
        }
      }
    }
    expect(uncovered).toEqual([]);
  });

  test('the three known collections are all present', () => {
    for (const collection of ['users', 'analyses', 'learning_records']) {
      expect(RULES).toContain(`match /${collection}/{`);
    }
  });
});

describe('the rules are restrictive', () => {
  test('access is tied to the signed-in user, never left open', () => {
    expect(RULES).toContain('request.auth != null');
    expect(RULES).toContain('request.auth.uid == userId');
  });

  test('nothing is granted unconditionally', () => {
    // "allow ...: if true" or a bare allow would expose every trader's records.
    expect(RULES).not.toMatch(/allow[^;]*:\s*if\s+true/);
    for (const line of RULES.split('\n')) {
      if (line.trim().startsWith('allow')) expect(line).toContain('if ');
    }
  });

  test('every allow is guarded by the ownership check', () => {
    const allows = RULES.split('\n').filter((l) => l.trim().startsWith('allow'));
    expect(allows.length).toBeGreaterThan(0);
    for (const line of allows) expect(line).toContain('isOwner(userId)');
  });
});

describe('the path scanner itself', () => {
  test('reads a nested path in the right order', () => {
    const paths = collectionPathsInSource("setDoc(doc(db, 'users', uid, 'learning_records', rec.id), x)");
    expect(paths).toContainEqual(['users', 'learning_records']);
  });

  test('reads a top level document', () => {
    expect(collectionPathsInSource("doc(db, 'users', uid)")).toContainEqual(['users']);
  });

  test('reads a collection reference', () => {
    expect(collectionPathsInSource("collection(db, 'users', uid, 'analyses')")).toContainEqual([
      'users',
      'analyses',
    ]);
  });

  test('ignores code that does not touch the database', () => {
    expect(collectionPathsInSource('const x = doc(other, "a", "b");')).toHaveLength(0);
  });
});
