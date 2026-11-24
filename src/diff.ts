import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DOCUMENTS_DIR = ".monitor-state/documents";
const STATE_REF = "origin/monitor-state";
const MAX_GIT_BUFFER = 64 * 1024 * 1024;

export interface DocumentName {
  path: string;
  base: string;
  family: string;
  version: number;
  extension: string;
}

// Parses ".monitor-state/documents/<name>-<url hash>.<ext>" into a base name,
// a version-less family name, and a comparable version number, so documents
// republished under a new versioned URL can be matched to their predecessors.
export function parseDocumentPath(path: string): DocumentName | null {
  const match = /([^/\\]+?)-[0-9a-f]{64}\.(pdf\.txt|ya?ml)$/u.exec(path);
  const base = match?.[1];
  const extension = match?.[2];
  if (base === undefined || extension === undefined) return null;
  const segments = base.split("-");
  const versionSegments: string[] = [];
  while (segments.length > 1 && /^\d+$/u.test(segments.at(-1)!)) {
    versionSegments.unshift(segments.pop()!);
  }
  if (segments.length > 1 && versionSegments.length > 0 && segments.at(-1)!.toLowerCase() === "v") {
    segments.pop();
  }
  return {
    path,
    base,
    extension,
    family: segments.join("-"),
    version: versionSegments.length === 0 ? -1 : Number(versionSegments.join("")),
  };
}

// Orders predecessor candidates: documents whose links were removed in the same
// update first, then by descending version. Unversioned URLs rank last.
export function rankPredecessors(
  added: DocumentName,
  parentDocuments: readonly DocumentName[],
  removedPaths: ReadonlySet<string>,
): DocumentName[] {
  return parentDocuments
    .filter((candidate) => candidate.family === added.family &&
      candidate.extension === added.extension && candidate.path !== added.path)
    .sort((a, b) =>
      Number(removedPaths.has(b.path)) - Number(removedPaths.has(a.path)) ||
      b.version - a.version ||
      a.base.localeCompare(b.base));
}

export interface ChangedDocument {
  status: "A" | "M" | "D";
  path: string;
}

export function parseNameStatus(output: string): ChangedDocument[] {
  return output.split("\n").flatMap((line) => {
    const match = /^([AMD])\t(.+)$/u.exec(line);
    const status = match?.[1];
    const path = match?.[2];
    if ((status !== "A" && status !== "M" && status !== "D") || path === undefined) return [];
    return [{ status, path }];
  });
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: MAX_GIT_BUFFER });
  if (result.error) throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function gitShow(reference: string, path: string): Buffer {
  const result = spawnSync("git", ["show", `${reference}:${path}`], { maxBuffer: MAX_GIT_BUFFER });
  if (result.error) throw new Error(`git show ${reference}:${path} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git show ${reference}:${path} failed: ${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout;
}

function openInVsCode(oldFile: string, newFile: string): boolean {
  // Windows: "code" is code.cmd, which cannot be spawned directly without a
  // shell. Pass arguments separately; a single command string gets its inner
  // quotes escaped as literal \" characters, breaking the paths.
  const result = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/c", "code", "--diff", oldFile, newFile])
    : spawnSync("code", ["--diff", oldFile, newFile]);
  return result.error === undefined && result.status === 0;
}

function describeCandidate(candidate: DocumentName, removedPaths: ReadonlySet<string>): string {
  return candidate.base + (removedPaths.has(candidate.path) ? " (link removed in this update)" : "");
}

function pickPredecessor(
  added: DocumentName,
  candidates: DocumentName[],
  removedPaths: ReadonlySet<string>,
): DocumentName | null {
  if (candidates.length === 1) return candidates[0] ?? null;
  console.log(`\nMultiple possible predecessors for ${added.base}:`);
  for (const [index, candidate] of candidates.entries()) {
    console.log(`  ${index + 1}. ${describeCandidate(candidate, removedPaths)}`);
  }
  if (!process.stdin.isTTY) {
    console.log(`Not an interactive terminal; comparing with ${candidates[0]?.base}.`);
    return candidates[0] ?? null;
  }
  const answer = prompt(`Compare with (0 to skip) [1]:`) ?? "";
  const choice = answer.trim() === "" ? 1 : Number.parseInt(answer, 10);
  if (choice === 0) return null;
  return candidates[Number.isInteger(choice) ? choice - 1 : 0] ?? candidates[0] ?? null;
}

interface DiffPair {
  oldReference: string;
  oldDocument: DocumentName;
  newReference: string;
  newDocument: DocumentName;
}

function extract(
  directory: string,
  prefix: "old" | "new",
  reference: string,
  document: DocumentName,
  usedNames: Set<string>,
): string {
  let name = `${prefix}-${document.base}.${document.extension}`;
  for (let suffix = 2; usedNames.has(name); suffix++) {
    name = `${prefix}-${document.base}-${suffix}.${document.extension}`;
  }
  usedNames.add(name);
  const file = join(directory, name);
  writeFileSync(file, gitShow(reference, document.path));
  return file;
}

function main(): void {
  try {
    git(["fetch", "--quiet", "origin", "monitor-state"]);
  } catch (error) {
    console.warn(`Could not fetch ${STATE_REF}; using the local copy.`,
      error instanceof Error ? error.message : "");
  }

  const requested = process.argv[2];
  const commit = (requested ?? git(["log", "-1", "--format=%H", STATE_REF, "--", DOCUMENTS_DIR])).trim();
  if (!commit) {
    throw new Error(`No commit on ${STATE_REF} has changed ${DOCUMENTS_DIR} yet.`);
  }
  console.log(`Comparing documents changed in: ${git(["log", "-1", "--date=iso", "--format=%h %ad %s", commit]).trim()}`);
  if (requested === undefined) {
    console.log("Pass a commit hash to compare a different update: bun run diff <commit>");
  }

  const changes = parseNameStatus(
    git(["diff", "--no-renames", "--name-status", `${commit}^`, commit, "--", DOCUMENTS_DIR]),
  );
  if (changes.length === 0) {
    console.log("No document changes in this commit (the article or snapshot metadata may still have changed).");
    return;
  }

  const parentDocuments = git(["ls-tree", "-r", "--name-only", `${commit}^`, "--", DOCUMENTS_DIR])
    .split("\n").flatMap((path) => parseDocumentPath(path) ?? []);
  const removedPaths: ReadonlySet<string> = new Set(
    changes.filter((change) => change.status === "D").map((change) => change.path),
  );

  const pairs: DiffPair[] = [];
  const pairedPredecessors = new Set<string>();
  for (const change of changes) {
    const document = parseDocumentPath(change.path);
    if (!document) {
      console.warn(`Skipping unrecognized document path: ${change.path}`);
      continue;
    }
    if (change.status === "M") {
      pairs.push({
        oldReference: `${commit}^`, oldDocument: document,
        newReference: commit, newDocument: document,
      });
    } else if (change.status === "A") {
      const candidates = rankPredecessors(document, parentDocuments, removedPaths);
      if (candidates.length === 0) {
        console.log(`New document with no known predecessor: ${document.base}.${document.extension}`);
        continue;
      }
      const predecessor = pickPredecessor(document, candidates, removedPaths);
      if (!predecessor) continue;
      pairedPredecessors.add(predecessor.path);
      pairs.push({
        oldReference: `${commit}^`, oldDocument: predecessor,
        newReference: commit, newDocument: document,
      });
    }
  }
  for (const path of removedPaths) {
    if (!pairedPredecessors.has(path)) {
      console.log(`Document link removed (no replacement matched): ${path}`);
    }
  }
  if (pairs.length === 0) {
    console.log("Nothing to diff.");
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), "skifteportalen-diff-"));
  const usedNames = new Set<string>();
  for (const pair of pairs) {
    const oldFile = extract(directory, "old", pair.oldReference, pair.oldDocument, usedNames);
    const newFile = extract(directory, "new", pair.newReference, pair.newDocument, usedNames);
    console.log(`\n${pair.oldDocument.base} -> ${pair.newDocument.base}`);
    if (openInVsCode(oldFile, newFile)) {
      console.log("Opened in VS Code.");
    } else {
      console.log(`Could not launch VS Code. Compare manually:\n  code --diff "${oldFile}" "${newFile}"`);
    }
  }
  console.log(`\nExtracted files are in ${directory}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Document diff failed");
    process.exitCode = 1;
  }
}
