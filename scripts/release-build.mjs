import { readdirSync } from "node:fs";
import path from "node:path";
import { RELEASE_ARTIFACTS } from "./check-release.mjs";

export const SOURCE_REPO = "Forward-Future/folio";
export const WORKFLOW = "release-build.yml";

// Run this in the trusted publisher. A workflow in an unmerged tag could claim its own checks passed.
export function verifyReleaseTag(api, tag, tagObject, commit) {
  const remote = api(`git/ref/tags/${tag}`);
  if (remote.ref !== `refs/tags/${tag}` || remote.object?.sha !== tagObject) throw new Error(`The source repository tag ${tag} differs from the local tag.`);
  const main = api("git/ref/heads/main").object?.sha;
  if (!/^[0-9a-f]{40}$/.test(main) || (main !== commit && api(`compare/${commit}...${main}?per_page=1`).merge_base_commit?.sha !== commit)) {
    throw new Error("The release commit must belong to the source repository's main branch.");
  }
}

export function selectBuild({ total_count, workflow_runs }, tag, commit) {
  if (total_count === 0 && workflow_runs.length === 0) return null;
  if (total_count !== 1 || workflow_runs.length !== 1) throw new Error(`Expected exactly one tag-push build for ${tag} at ${commit}.`);
  const [run] = workflow_runs;
  if (run.path !== `.github/workflows/${WORKFLOW}` || run.event !== "push" || run.head_branch !== tag
      || run.head_sha !== commit || run.head_repository?.full_name !== SOURCE_REPO || !Number.isSafeInteger(run.id)) {
    throw new Error("The release build does not match the source repository, workflow, tag and commit.");
  }
  return run;
}

export function successfulAttempt(run, runId) {
  if (run?.id !== runId || run.status !== "completed" || run.conclusion !== "success" || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
    throw new Error("The tag-push build must finish successfully before publishing.");
  }
  return run.run_attempt;
}

// Artifacts are immutable. A rerun may replace a platform's archive; require the same three IDs throughout the download.
export function artifactIds({ total_count, artifacts }, run) {
  const groups = Object.keys(RELEASE_ARTIFACTS);
  if (total_count !== groups.length || artifacts.length !== groups.length) throw new Error("Expected one artifact per platform.");
  return groups.map((name) => {
    const artifact = artifacts.find((a) => a.name === name);
    if (!artifact || artifact.expired !== false || !Number.isSafeInteger(artifact.id)
        || artifact.workflow_run?.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha) {
      throw new Error(`Missing or invalid ${name} artifact for this build.`);
    }
    return artifact.id;
  }).join(",");
}

export function releaseFiles(folder) {
  const groups = readdirSync(folder, { withFileTypes: true });
  if (groups.length !== Object.keys(RELEASE_ARTIFACTS).length || groups.some((group) => !group.isDirectory() || !Object.hasOwn(RELEASE_ARTIFACTS, group.name))) {
    throw new Error("Unexpected platform artifact directories.");
  }
  const files = [];
  for (const [group, manifest] of Object.entries(RELEASE_ARTIFACTS)) {
    const dir = path.join(folder, group);
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.length !== manifest.length || entries.some((entry) => !entry.isFile() || !manifest.some(({ name }) => name === entry.name))) {
      throw new Error(`The contents of ${group} do not match the release manifest.`);
    }
    for (const { name } of manifest) files.push(path.join(dir, name));
  }
  return files;
}
