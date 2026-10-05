import assert from "node:assert/strict";
import { test } from "node:test";
import { createApi, missingTwins, runCoverageCheck } from "./harness-coverage-check.mjs";

const oc = "packages/plugin/src/hooks/magic-context/temporal-awareness.ts";
const pi = "packages/pi-plugin/src/temporal-awareness-pi.ts";
const files = [oc, pi, "packages/plugin/src/shared/only-here.ts"];

test("Pi-only diff flags the OpenCode twin", () => {
  assert.deepEqual(missingTwins([pi], files), [{ changed: pi, missing: oc }]);
});
test("OpenCode-only diff flags the Pi twin", () => {
  assert.deepEqual(missingTwins([oc], files), [{ changed: oc, missing: pi }]);
});
test("no twin exists is a negative control", () => {
  assert.deepEqual(missingTwins([files[2]], files), []);
});
test("both twins changed need no advisory", () => {
  assert.deepEqual(missingTwins([oc, pi], files), []);
});
test("same relative name pairs in both directions", () => {
  const a = "packages/plugin/src/tools/example.ts";
  const b = "packages/pi-plugin/src/tools/example.ts";
  assert.deepEqual(missingTwins([a], [a, b]), [{ changed: a, missing: b }]);
  assert.deepEqual(missingTwins([b], [a, b]), [{ changed: b, missing: a }]);
});
test("advisory is updated once and cleared when coverage catches up", async () => {
  const comments = [];
  const api = {
    listComments: async () => comments,
    createComment: async (_, body) => comments.push({ id: 1, body }),
    updateComment: async (_, body) => { comments[0].body = body; },
  };
  await runCoverageCheck({ api, number: 1, changedFiles: [oc], repositoryFiles: files });
  assert.match(comments[0].body, /temporal-awareness-pi.ts/);
  await runCoverageCheck({ api, number: 1, changedFiles: [oc], repositoryFiles: files });
  assert.equal(comments.length, 1);
  await runCoverageCheck({ api, number: 1, changedFiles: [oc, pi], repositoryFiles: files });
  assert.match(comments[0].body, /No missing conventional twins/);
});

test("GitHub file and comment listings paginate", async () => {
  const urls = [];
  const api = createApi({ token: "fixture", repo: "owner/repo", fetchImpl: async (url) => {
    urls.push(url);
    return { ok: true, json: async () => url.endsWith("page=1")
      ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }] };
  } });
  assert.equal((await api.listFiles(1)).length, 101);
  assert.equal((await api.listComments(1)).length, 101);
  assert.equal(urls.length, 4);
  assert.ok(urls[1].endsWith("/pulls/1/files?per_page=100&page=2"));
});

test("untouched PRs do not create an advisory comment", async () => {
  await runCoverageCheck({
    api: { listComments: async () => [], createComment: () => assert.fail("unexpected comment") },
    number: 1, changedFiles: [files[2]], repositoryFiles: files,
  });
});
