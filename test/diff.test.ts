import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDocumentPath, parseNameStatus, rankPredecessors } from "../src/diff.ts";

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);
const documentPath = (base: string, seed: string, extension = "yaml"): string =>
  `.monitor-state/documents/${base}-${hash(seed)}.${extension}`;

test("parses document paths into family and version", () => {
  assert.deepEqual(parseDocumentPath(documentPath("sagshylde-dist-oas-320", "a")), {
    path: documentPath("sagshylde-dist-oas-320", "a"),
    base: "sagshylde-dist-oas-320",
    family: "sagshylde-dist-oas",
    version: 320,
    extension: "yaml",
  });
  assert.equal(parseDocumentPath(documentPath("sagshylde-dist-oas", "b"))?.version, -1);
  assert.equal(parseDocumentPath(documentPath("retskreds-dist-oas-2-0-0", "c"))?.family, "retskreds-dist-oas");
  assert.equal(parseDocumentPath(documentPath("retskreds-dist-oas-2-0-0", "c"))?.version, 200);
  const versioned = parseDocumentPath(documentPath("insolvens-dirigent-ekstern-oas-v-8-12-10", "d"));
  assert.equal(versioned?.family, "insolvens-dirigent-ekstern-oas");
  assert.equal(versioned?.version, 81210);
  const pdf = parseDocumentPath(documentPath("integrationsvejledning-eksterne-apier", "e", "pdf.txt"));
  assert.equal(pdf?.extension, "pdf.txt");
  assert.equal(pdf?.version, -1);
  assert.equal(parseDocumentPath(".monitor-state/snapshot.json"), null);
  assert.equal(parseDocumentPath(`.monitor-state/documents/spec-${hash("f")}.exe`), null);
});

test("ranks predecessors by removed link, then version, for new-URL successors", () => {
  const added = parseDocumentPath(documentPath("sagshylde-dist-oas-320", "1"));
  assert.ok(added);
  const parents = [
    documentPath("sagshylde-dist-oas", "2"),
    documentPath("sagshylde-dist-oas-255", "3"),
    documentPath("sagshylde-dist-oas-260", "4"),
    documentPath("henvendelse-dist-oas", "5"),
    documentPath("sagshylde-dist-oas-260", "6", "pdf.txt"),
  ].map((path) => {
    const parsed = parseDocumentPath(path);
    assert.ok(parsed);
    return parsed;
  });
  const removed = new Set([documentPath("sagshylde-dist-oas-255", "3")]);
  const ranked = rankPredecessors(added, parents, removed);
  assert.deepEqual(ranked.map((candidate) => candidate.base), [
    "sagshylde-dist-oas-255",
    "sagshylde-dist-oas-260",
    "sagshylde-dist-oas",
  ]);
});

test("parses git name-status output and ignores other lines", () => {
  const changes = parseNameStatus([
    `A\t${documentPath("sagshylde-dist-oas-320", "a")}`,
    `D\t${documentPath("sagshylde-dist-oas-255", "b")}`,
    `M\t${documentPath("henvendelse-dist-oas", "c")}`,
    "",
    "warning: unrelated",
  ].join("\n"));
  assert.deepEqual(changes.map((change) => change.status), ["A", "D", "M"]);
});
