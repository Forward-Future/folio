import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RELEASE_ARTIFACTS } from "./check-release.mjs";
import { artifactIds, releaseFiles, selectBuild, successfulAttempt, verifyReleaseTag, SOURCE_REPO } from "./release-build.mjs";

const tag = "v1.2.3";
const commit = "a".repeat(40);
const build = {
  id: 42, event: "push", head_branch: tag, head_sha: commit, path: ".github/workflows/release-build.yml", head_repository: { full_name: SOURCE_REPO },
  status: "completed", conclusion: "success", run_attempt: 2,
};
const select = (...runs) => selectBuild({ total_count: runs.length, workflow_runs: runs }, tag, commit);

test("publisher requires the original tag object and a commit on canonical main", () => {
  const tagObject = "1".repeat(40), main = "b".repeat(40);
  const responses = new Map([
    [`git/ref/tags/${tag}`, { ref: `refs/tags/${tag}`, object: { sha: tagObject } }],
    ["git/ref/heads/main", { object: { sha: main } }],
    [`compare/${commit}...${main}?per_page=1`, { merge_base_commit: { sha: commit } }],
  ]);
  const verify = () => verifyReleaseTag(key => responses.get(key), tag, tagObject, commit);
  verify();
  responses.get(`compare/${commit}...${main}?per_page=1`).merge_base_commit.sha = "c".repeat(40);
  assert.throws(verify, /main branch/);
  responses.get("git/ref/heads/main").object.sha = commit;
  verify();
  responses.get(`git/ref/tags/${tag}`).object.sha = main;
  assert.throws(verify, /differs from the local tag/);
});

test("only a unique matching tag-push build can supply a successful attempt", () => {
  assert.equal(select(), null);
  assert.equal(successfulAttempt(select(build), 42), 2);
  for (const change of [{ event: "workflow_dispatch" }, { head_sha: "b".repeat(40) }, { head_branch: "main" },
    { path: ".github/workflows/ci.yml" }, { head_repository: { full_name: "example/fork" } }]) {
    assert.throws(() => select({ ...build, ...change }));
  }
  assert.throws(() => select(build, { ...build, id: 43 }));
  for (const change of [{ conclusion: "failure" }, { conclusion: "skipped" }, { status: "in_progress" }, { id: 43 }]) {
    assert.throws(() => successfulAttempt({ ...build, ...change }, 42));
  }
});

test("archives must be unexpired and belong to the same run and SHA", () => {
  const groups = Object.keys(RELEASE_ARTIFACTS);
  const archives = groups.map((name, i) => ({ name, id: i + 1, expired: false, workflow_run: { id: 42, head_sha: commit } }));
  const ids = (artifacts) => artifactIds({ total_count: artifacts.length, artifacts }, build);
  assert.equal(ids(archives), ids(archives.toReversed()));
  for (const change of [{ name: groups[1] }, { expired: true }, { workflow_run: { id: 44, head_sha: commit } },
    { workflow_run: { id: 42, head_sha: "b".repeat(40) } }]) {
    assert.throws(() => ids([{ ...archives[0], ...change }, ...archives.slice(1)]));
  }
  assert.notEqual(ids([{ ...archives[0], id: 4 }, ...archives.slice(1)]), ids(archives));
  assert.throws(() => ids([...archives, archives[0]]));
});

test("only manifest files from the correct platform directory can be published", (t) => {
  const folder = mkdtempSync(path.join(tmpdir(), "folio-release-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  for (const [group, assets] of Object.entries(RELEASE_ARTIFACTS)) {
    mkdirSync(path.join(folder, group));
    for (const { name } of assets) writeFileSync(path.join(folder, group, name), "");
  }
  const mac = path.join(folder, "folio-macos");
  const win = path.join(folder, "folio-windows");
  const files = releaseFiles(folder);
  assert.ok(files.includes(path.join(mac, "Folio-mac.zip.blockmap")));
  assert.ok(files.includes(path.join(mac, "Folio-mac.dmg.blockmap")));
  writeFileSync(path.join(mac, "unrelated.exe"), "");
  assert.throws(() => releaseFiles(folder));
  rmSync(path.join(mac, "unrelated.exe"));
  renameSync(path.join(mac, "latest-mac.yml"), path.join(win, "latest-mac.yml"));
  assert.throws(() => releaseFiles(folder));
  rmSync(path.join(win, "latest-mac.yml"));
  mkdirSync(path.join(mac, "latest-mac.yml"));
  assert.throws(() => releaseFiles(folder));
});
