#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

const OC = "packages/plugin/src/";
const PI = "packages/pi-plugin/src/";
export const COMMENT_MARKER = "<!-- harness-coverage-check -->";

export function missingTwins(changedFiles, repositoryFiles) {
  const changed = new Set(changedFiles);
  const known = [...new Set([...repositoryFiles, ...changed])];
  const pairs = [];
  for (const oc of known.filter((file) => file.startsWith(OC))) {
    const relative = oc.slice(OC.length);
    for (const pi of known.filter((file) => file.startsWith(PI))) {
      const piRelative = pi.slice(PI.length);
      // Pi adapters often live at the source root while OpenCode hooks are nested.
      const suffixTwin = piRelative.endsWith("-pi.ts") &&
        posix.basename(piRelative).replace(/-pi\.ts$/, ".ts") === posix.basename(relative);
      if (piRelative !== relative && !suffixTwin) continue;
      if (changed.has(oc) && !changed.has(pi)) pairs.push({ changed: oc, missing: pi });
      if (changed.has(pi) && !changed.has(oc)) pairs.push({ changed: pi, missing: oc });
    }
  }
  return pairs.sort((a, b) => `${a.changed}:${a.missing}`.localeCompare(`${b.changed}:${b.missing}`));
}

export async function runCoverageCheck({ api, number, changedFiles, repositoryFiles }) {
  const missing = missingTwins(changedFiles, repositoryFiles);
  const existing = (await api.listComments(number)).find((comment) =>
    (comment.body ?? "").startsWith(COMMENT_MARKER));
  if (!missing.length && !existing) return;
  const body = `${COMMENT_MARKER}\n\n${missing.length
    ? "Harness coverage advisory: these conventional twins were not touched:\n\n" +
      missing.map((pair) => `- \`${pair.changed}\` → \`${pair.missing}\``).join("\n") +
      "\n\nCover every shipped harness or explain why the surface does not exist there. " +
      "See CONTRIBUTING.md. This is advisory only; no draft state is changed."
    : "No missing conventional twins in the current diff. Full harness coverage still needs review."}`;
  if (!existing) await api.createComment(number, body);
  else if (existing.body !== body) await api.updateComment(existing.id, body);
}

export function createApi({ token, repo, fetchImpl = fetch }) {
  async function request(path, method = "GET", body) {
    const response = await fetchImpl(`${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
        "content-type": "application/json", "x-github-api-version": "2022-11-28" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status}`);
    return response.json();
  }
  async function pages(path) {
    const result = [];
    for (let page = 1; ; page++) {
      const batch = await request(`${path}?per_page=100&page=${page}`);
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  }
  return {
    listFiles: (number) => pages(`/pulls/${number}/files`),
    listComments: (number) => pages(`/issues/${number}/comments`),
    createComment: (number, body) => request(`/issues/${number}/comments`, "POST", { body }),
    updateComment: (id, body) => request(`/issues/comments/${id}`, "PATCH", { body }),
  };
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const api = createApi({ token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPOSITORY });
  const files = await api.listFiles(event.pull_request.number);
  // GitHub caps PR file listings at 3000; do not silently report complete coverage.
  if (files.length >= 3000) throw new Error("PR file list may be truncated at GitHub's 3000-file limit");
  const changedFiles = files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean));
  // Enumerate trusted base paths, never load or execute contributor source files.
  const repositoryFiles = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", "HEAD"],
    { encoding: "utf8" }).split("\0").filter(Boolean);
  await runCoverageCheck({ api, number: event.pull_request.number, changedFiles, repositoryFiles });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.warn(`Harness coverage advisory could not complete: ${error.message}`);
  });
}
