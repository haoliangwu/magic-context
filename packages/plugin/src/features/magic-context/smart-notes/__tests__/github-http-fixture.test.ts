/** Representative GitHub response headers and JSON bodies; no public API calls. */
export const GITHUB_RUNS_URL =
    "https://api.github.com/repos/cortexkit/insula/actions/runs?event=schedule&created=%3E2026-09-30T14%3A00Z&per_page=10";
export const GITHUB_FAILURE_CONDITION =
    "A scheduled (event=schedule) CI workflow run on github.com/cortexkit/insula created after 2026-09-30T14:00Z has conclusion 'failure'";
export const GITHUB_FAILURE_CHECK = `function check(cap) {
    var response = cap.httpGet("${GITHUB_RUNS_URL}");
    if (response.status !== 200) throw new Error("HTTP request failed with status " + response.status);
    return {met: JSON.parse(response.body).workflow_runs.some(function(run) {
        return run.event === "schedule" && run.created_at > "2026-09-30T14:00:00Z" && run.conclusion === "failure";
    })};
}`;

const primaryBody = JSON.stringify({
    message:
        "API rate limit exceeded for 192.0.2.1. (But here's the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)",
    documentation_url:
        "https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting",
});
const secondaryBody = JSON.stringify({
    message:
        "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
    documentation_url:
        "https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits",
});

interface GithubRateLimitResponse {
    name: string;
    status: number;
    headers: Record<string, string>;
    body: string;
    delayMs: number;
}

export function githubRateLimitResponses(reset: number): GithubRateLimitResponse[] {
    return [
        {
            name: "primary 403",
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
            body: primaryBody,
            delayMs: 0,
        },
        {
            name: "secondary 403 Retry-After",
            status: 403,
            headers: { "x-ratelimit-remaining": "59", "retry-after": "3600" },
            body: secondaryBody,
            delayMs: 3600_000,
        },
        {
            name: "secondary 429 Retry-After",
            status: 429,
            headers: { "retry-after": "3600" },
            body: secondaryBody,
            delayMs: 3600_000,
        },
        {
            name: "secondary 403 body only",
            status: 403,
            headers: { "x-ratelimit-remaining": "59" },
            body: secondaryBody,
            delayMs: 300_000,
        },
        {
            name: "secondary 429 body only",
            status: 429,
            headers: {},
            body: secondaryBody,
            delayMs: 300_000,
        },
    ];
}

export const githubPrivateResponses = [
    {
        status: 404,
        body: '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/repos#get-a-repository","status":"404"}',
    },
    {
        status: 403,
        body: '{"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest/actions/workflow-runs#list-workflow-runs-for-a-repository","status":"403"}',
    },
];
