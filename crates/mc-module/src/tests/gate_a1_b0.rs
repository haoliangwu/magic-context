//! Adversarial gate over the host-runner slice (A1) merged with the
//! single-store marker slice (B0).
//!
//! Every test here drives the real dispatcher, the real store and the real
//! restart path, and each one exists to settle one claim the two deliveries
//! make. Where a test records behaviour the deliveries did not claim, its name
//! says what it observed rather than what it approves of.

use super::*;
use rusqlite::Connection;

const GATE_SYSTEM_PROMPT: &str = "gate-system-prompt";
const GATE_AWAIT_BUDGET_MS: i64 = 660_000;

/// Open the store file a test handler is using, read-only, so a test can see
/// the claim queue rows the public API does not expose.
fn queue_rows(
    data_home: &std::path::Path,
) -> Vec<(String, String, String, Option<String>, String)> {
    let path = sqlite_store_path(data_home.to_str().unwrap(), DEFAULT_MODULE_ID);
    let conn = Connection::open(&path).unwrap();
    let mut statement = conn
        .prepare(
            "SELECT run_id, session_id, phase, coordinator_token, chunk_fingerprint
               FROM mc_historian_pending_run ORDER BY run_id",
        )
        .unwrap();
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    rows
}

/// Park `session_id` on a firing and queue its run for a claimant, exactly as
/// the host lane does between assembling the chunk and waiting for a report.
fn queue_run_for(
    store: &McStore,
    session_id: &str,
    run_id: &str,
    project_path: &str,
    user_prompt: &str,
    now_ms: i64,
) {
    let loaded = store.load(session_id).unwrap();
    let mut meta = loaded.meta.clone();
    meta.historian = HistorianDurableState {
        state: HistorianPhase::Firing,
        firing_seq: 1,
        chunk_range: Some(HistorianChunkRange {
            from_ordinal: 1,
            to_ordinal: 3,
        }),
        chunk_fingerprint: format!("fp-{session_id}"),
        fired_at_ms: Some(now_ms),
        ..HistorianDurableState::default()
    };
    store
        .commit(session_id, loaded.row_version, &loaded.core, &meta)
        .unwrap();
    store
        .publish_pending_historian_run(&mc_store::NewHistorianPendingRun {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            project_path: project_path.to_string(),
            firing_seq: 1,
            chunk_fingerprint: format!("fp-{session_id}"),
            system_prompt: GATE_SYSTEM_PROMPT.to_string(),
            user_prompt: user_prompt.to_string(),
            model_chain: vec!["test/first".to_string()],
            await_budget_ms: GATE_AWAIT_BUDGET_MS,
            historian_timeout_ms: None,
            now_ms,
        })
        .unwrap();
}

/// The claim lane is scoped to the channel's binding, like every other
/// management op that reads session state: an unbound channel is refused
/// `route_unbound`, and a bound one is never shown a run another project queued.
///
/// A claim hands back the run's prompts, which are the folded conversation
/// transcript. Two projects on one machine share one module store, so without
/// this scope each project's host process could list the other's runs, read its
/// transcripts and complete its folds. A claimant still discovers runs by
/// polling without naming a session — what it cannot do is poll outside its own
/// project.
#[tokio::test(flavor = "current_thread")]
async fn gate_pending_refuses_an_unbound_caller_and_hides_another_projects_run() {
    let (handler, store, dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let now = now_ms();
    queue_run_for(
        &store,
        "ses",
        "run-own-project",
        &project.to_string_lossy(),
        "transcript of the bound project",
        now,
    );
    queue_run_for(
        &store,
        "other-project-session",
        "run-other-project",
        "/somewhere/else/entirely",
        "transcript of a project this channel never bound",
        now,
    );

    // Channel 9 never bound anything. The management op that reads session state
    // refuses it, and so now does every op in the claim lane.
    let (unbound_code, _) = error_frame(
        handler
            .dispatch_value(
                9,
                json!({ "method": "session.status", "v": 1, "session_id": "ses" }),
            )
            .await,
    );
    assert_eq!(
        unbound_code, "route_unbound",
        "the comparison surface has to actually refuse an unbound channel"
    );
    for request in [
        json!({ "method": "historian.pending", "v": 1 }),
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": "run-other-project", "claimant_instance_id": "some-other-install",
        }),
        json!({ "method": "historian.heartbeat", "v": 1, "run_id": "run-other-project", "token": "t" }),
        json!({
            "method": "historian.complete", "v": 1,
            "run_id": "run-other-project", "token": "t",
            "output": { "text": "<compartments/>" },
        }),
    ] {
        let (code, _) = error_frame(handler.dispatch_value(9, request.clone()).await);
        assert_eq!(code, "route_unbound", "{request}");
    }

    // Channel 7 is bound to `project`. It sees its own run and only its own run.
    let listed =
        call_dispatch_request(&handler, json!({ "method": "historian.pending", "v": 1 })).await;
    let run_ids: Vec<&str> = listed["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|run| run["run_id"].as_str().unwrap())
        .collect();
    assert_eq!(
        run_ids,
        vec!["run-own-project"],
        "pending lists the caller's own project only: {listed}"
    );

    let foreign = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim",
            "v": 1,
            "run_id": "run-other-project",
            "claimant_instance_id": "install-one",
        }),
    )
    .await;
    assert_eq!(
        foreign,
        json!({ "ok": false, "refusal": "unknown_run" }),
        "another project's run is answered as one that does not exist, so nothing about it leaks"
    );

    // The control: the caller's own run claims normally and hands back its prompt,
    // so the refusal above is about the project rather than about the lane being
    // closed.
    let own = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim",
            "v": 1,
            "run_id": "run-own-project",
            "claimant_instance_id": "install-one",
        }),
    )
    .await;
    assert_eq!(own["ok"], json!(true), "{own}");
    assert_eq!(
        own["prompt"]["user"],
        json!("transcript of the bound project")
    );
    drop(dir);
}

/// `v` is documented on all four claim requests and pinned in the wire fixture
/// (`crates/mc-module/testdata/historian-claim-wire-golden.json`), and every one
/// of them now reads it: a request with no `v`, or with a version
/// this module has never heard of, is refused `bad_request` exactly as the
/// management ops beside them refuse it.
///
/// A version field that is never read is worse than none, because a future v2
/// claimant would be silently served v1 semantics instead of being told this
/// module does not speak v2.
#[tokio::test(flavor = "current_thread")]
async fn gate_the_claim_lane_refuses_a_request_whose_version_it_cannot_serve() {
    let (handler, store, dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    queue_run_for(
        &store,
        "ses",
        "run-versionless",
        &project.to_string_lossy(),
        "transcript",
        now_ms(),
    );

    let (bad_code, _) = error_frame(
        handler
            .dispatch_value(
                7,
                json!({ "method": "session.status", "session_id": "ses" }),
            )
            .await,
    );
    assert_eq!(
        bad_code, "bad_request",
        "the comparison surface has to actually require a version"
    );

    for method in [
        "historian.pending",
        "historian.claim",
        "historian.heartbeat",
        "historian.complete",
    ] {
        for version in [None, Some(json!(99)), Some(json!("not-a-number"))] {
            let mut request = json!({
                "method": method,
                "run_id": "run-versionless",
                "claimant_instance_id": "install-one",
                "token": "0".repeat(32),
                "output": { "text": "<compartments/>" },
            });
            if let Some(version) = version.clone() {
                request["v"] = version;
            }
            let (code, message) = error_frame(handler.dispatch_value(7, request.clone()).await);
            assert_eq!(code, "bad_request", "{request}");
            assert!(message.contains("v=1"), "{request} -> {message}");
        }
    }

    // The control: the same request at the version this module serves is answered.
    let served =
        call_dispatch_request(&handler, json!({ "method": "historian.pending", "v": 1 })).await;
    assert_eq!(served["runs"][0]["run_id"], json!("run-versionless"));
    drop(dir);
}

/// Two claimants reaching for one run: exactly one gets a token, and the loser
/// is told which kind of loss it was.
#[tokio::test(flavor = "current_thread")]
async fn gate_two_claimants_on_one_run_leave_exactly_one_live_token() {
    let (handler, store, dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    queue_run_for(
        &store,
        "ses",
        "run-contested",
        &project.to_string_lossy(),
        "transcript",
        now_ms(),
    );

    let first = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": "run-contested", "claimant_instance_id": "install-one",
        }),
    )
    .await;
    let second = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": "run-contested", "claimant_instance_id": "install-two",
        }),
    )
    .await;

    assert_eq!(first["ok"], json!(true), "{first}");
    assert_eq!(first["attempt"], json!(1));
    assert_eq!(
        second,
        json!({ "ok": false, "refusal": "already_claimed" }),
        "the second claimant is told the run is held, not that it is gone"
    );

    let state = store.historian_state("ses").unwrap();
    assert_eq!(state.state, HistorianPhase::AwaitingProducer);
    assert_eq!(state.producer_attempt, 1);
    assert_eq!(
        state.coordinator_token.as_deref(),
        first["token"].as_str(),
        "the session's own state names the one claim that won"
    );
    let rows = queue_rows(&dir.path().join("data"));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].2, "claimed");
    assert_eq!(rows[0].3.as_deref(), first["token"].as_str());
    drop(dir);
}

/// A claimant that blew its lease and one that arrives after it: whichever
/// request reaches the store first decides, and the other is refused with the
/// code that says why.
///
/// Both orders are driven. The first order records behaviour neither delivery
/// document states: a heartbeat arriving after the lease already lapsed is
/// accepted and revives the claim, so the replacement is then refused
/// `already_claimed`.
#[tokio::test(flavor = "current_thread")]
async fn gate_a_late_heartbeat_and_a_post_expiry_claim_never_both_win() {
    for heartbeat_first in [true, false] {
        let (handler, store, dir, project) =
            handler_with_store(Arc::new(ProducerState::default()), default_test_config());
        // Queued far enough back that the lease has lapsed while the run's own
        // deadline has not: those are different clocks, which is what leaves a
        // re-claim worth offering.
        let queued_at_ms = now_ms() - mc_store::HISTORIAN_LEASE_CEILING_MS - 1;
        queue_run_for(
            &store,
            "ses",
            "run-expiring",
            &project.to_string_lossy(),
            "transcript",
            queued_at_ms,
        );
        let mc_store::HistorianClaimOutcome::Claimed(held) = store
            .claim_historian_run(
                &project.to_string_lossy(),
                "run-expiring",
                "install-one",
                queued_at_ms,
            )
            .unwrap()
        else {
            panic!("the first claimant must win");
        };

        let beat = json!({
            "method": "historian.heartbeat", "v": 1,
            "run_id": "run-expiring", "token": held.token,
        });
        let claim = json!({
            "method": "historian.claim", "v": 1,
            "run_id": "run-expiring", "claimant_instance_id": "install-two",
        });

        let (beat_answer, claim_answer) = if heartbeat_first {
            let b = call_dispatch_request(&handler, beat).await;
            let c = call_dispatch_request(&handler, claim).await;
            (b, c)
        } else {
            let c = call_dispatch_request(&handler, claim).await;
            let b = call_dispatch_request(&handler, beat).await;
            (b, c)
        };

        if heartbeat_first {
            assert_eq!(
                beat_answer["ok"],
                json!(true),
                "an expired lease is revived by a beat that arrives before a replacement: {beat_answer}"
            );
            assert_eq!(
                claim_answer,
                json!({ "ok": false, "refusal": "already_claimed" }),
                "{claim_answer}"
            );
            let state = store.historian_state("ses").unwrap();
            assert_eq!(state.producer_attempt, 1);
            assert_eq!(
                state.coordinator_token.as_deref(),
                Some(held.token.as_str())
            );
        } else {
            assert_eq!(claim_answer["ok"], json!(true), "{claim_answer}");
            assert_eq!(claim_answer["attempt"], json!(2));
            assert_eq!(
                beat_answer,
                json!({
                    "ok": false,
                    "refusal": "superseded_token",
                }),
                "the replaced claimant's beat cannot extend a claim it no longer holds"
            );
            let state = store.historian_state("ses").unwrap();
            assert_eq!(state.producer_attempt, 2);
            assert_ne!(
                state.coordinator_token.as_deref(),
                Some(held.token.as_str())
            );
        }

        // Whichever order ran, the durable state names exactly one live claim.
        let rows = queue_rows(&dir.path().join("data"));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].2, "claimed");
        assert_eq!(
            rows[0].3,
            store.historian_state("ses").unwrap().coordinator_token,
            "the queue row and the session state agree on who holds the run"
        );
        drop(dir);
    }
}

/// Every refusal `historian.complete` can give, driven through the dispatcher:
/// a superseded token, a run that was never queued, and a run nobody holds.
#[tokio::test(flavor = "current_thread")]
async fn gate_complete_refuses_a_superseded_an_unknown_and_an_unclaimed_run() {
    let (handler, store, dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let queued_at_ms = now_ms() - mc_store::HISTORIAN_LEASE_CEILING_MS - 1;
    queue_run_for(
        &store,
        "ses",
        "run-reported",
        &project.to_string_lossy(),
        "transcript",
        queued_at_ms,
    );

    let unknown = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.complete", "v": 1,
            "run_id": "run-that-was-never-queued", "token": "0".repeat(32),
            "output": { "text": "<compartments/>" },
        }),
    )
    .await;
    assert_eq!(unknown, json!({ "ok": false, "refusal": "unknown_run" }));

    let unclaimed = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.complete", "v": 1,
            "run_id": "run-reported", "token": "0".repeat(32),
            "output": { "text": "<compartments/>" },
        }),
    )
    .await;
    assert_eq!(
        unclaimed,
        json!({ "ok": false, "refusal": "not_claimed" }),
        "nobody holds the run, so no token can be the current one"
    );

    let mc_store::HistorianClaimOutcome::Claimed(first) = store
        .claim_historian_run(
            &project.to_string_lossy(),
            "run-reported",
            "install-one",
            queued_at_ms,
        )
        .unwrap()
    else {
        panic!("the first claimant must win");
    };
    let second = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": "run-reported", "claimant_instance_id": "install-two",
        }),
    )
    .await;
    assert_eq!(second["attempt"], json!(2), "{second}");

    // A waiter exists, so the only thing that can refuse this report is the
    // token check — which runs before the body is parsed.
    let _registration = handler.host_runs.register("run-reported");
    let superseded = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.complete", "v": 1,
            "run_id": "run-reported", "token": first.token,
            "output": { "text": "not valid compartment xml at all" },
        }),
    )
    .await;
    assert_eq!(
        superseded,
        json!({ "ok": false, "refusal": "superseded_token" }),
        "a prior attempt's report is refused in every phase, before its body is read"
    );
    drop(dir);
}

/// A heartbeat sent after the run's OWN deadline has passed is refused
/// `run_expired` rather than answered `ok` with a lease already in the past.
///
/// By then the same run is unclaimable and unlistable — `historian.pending` and
/// `historian.claim` both refuse it on the run deadline — so an `ok` here would
/// be the one answer in the lane still telling a claimant to keep going after
/// the module stopped waiting. A claimant that reads `ok` as "keep working"
/// would keep paying a provider for a completion that can no longer be
/// delivered.
#[tokio::test(flavor = "current_thread")]
async fn gate_a_heartbeat_after_the_runs_own_deadline_is_refused_run_expired() {
    let (handler, store, dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let queued_at_ms = now_ms() - GATE_AWAIT_BUDGET_MS - 1;
    queue_run_for(
        &store,
        "ses",
        "run-past-deadline",
        &project.to_string_lossy(),
        "transcript",
        queued_at_ms,
    );
    // Claimed while the run was still live, so there is a current token to beat with.
    let mc_store::HistorianClaimOutcome::Claimed(held) = store
        .claim_historian_run(
            &project.to_string_lossy(),
            "run-past-deadline",
            "install-one",
            queued_at_ms,
        )
        .unwrap()
    else {
        panic!("the claim has to be taken before the deadline to set this up");
    };

    let listed =
        call_dispatch_request(&handler, json!({ "method": "historian.pending", "v": 1 })).await;
    assert_eq!(
        listed,
        json!({ "ok": true, "runs": [] }),
        "a run past its own deadline is never offered again"
    );
    let reclaim = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": "run-past-deadline", "claimant_instance_id": "install-two",
        }),
    )
    .await;
    assert_eq!(reclaim, json!({ "ok": false, "refusal": "not_pending" }));

    let beat = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.heartbeat", "v": 1,
            "run_id": "run-past-deadline", "token": held.token,
        }),
    )
    .await;
    assert_eq!(
        beat,
        json!({ "ok": false, "refusal": "run_expired" }),
        "the whole lane now agrees the run is over"
    );
    drop(dir);
}

/// Restart with a run parked for a claimant: the run is released, nothing
/// double-publishes, and the queue row it was advertised through is parked with
/// it rather than left offering work no one is waiting for.
///
/// A parked row is kept rather than deleted because it still carries the chunk
/// fingerprint and the prompt bytes, which is exactly what a boot-time
/// re-publication needs and what re-assembling a chunk would otherwise cost. It
/// is not offered to claimants while parked, and the claim sweep deletes it once
/// the run's own deadline passes, so the row cannot outlive the work it stands
/// for.
#[tokio::test(flavor = "current_thread")]
async fn gate_restart_releases_a_parked_run_and_parks_its_queue_row() {
    let (handler, store, dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let data_home = dir.path().join("data");
    let now = now_ms();
    queue_run_for(
        &store,
        "ses",
        "run-parked",
        &project.to_string_lossy(),
        "transcript",
        now,
    );

    let parked = store.historian_state("ses").unwrap();
    assert_eq!(parked.state, HistorianPhase::Reclaiming);
    assert_eq!(parked.chunk_fingerprint, "fp-ses");
    assert_eq!(parked.firing_seq, 1);

    // The boot path, called exactly as the transform recovery arm calls it.
    let action = crate::historian::handle_restart_load(&store, "ses", now, now + 60_000).unwrap();
    assert!(
        matches!(
            action,
            crate::historian::RestartAction::AbandonedAndRefireEligible { firing_seq: 1 }
        ),
        "a parked run is released on boot: {action:?}"
    );

    let released = store.historian_state("ses").unwrap();
    assert_eq!(released.state, HistorianPhase::Idle);
    assert_eq!(released.producer_run_id, None);
    assert_eq!(released.coordinator_token, None);
    assert_eq!(
        released.firing_seq, 1,
        "the failed sequence is kept so the next fire stays monotonic"
    );
    assert_eq!(
        released.chunk_fingerprint, "",
        "the released run's chunk identity is dropped from the session with it, so the \
         next trigger assembles a fresh chunk rather than publishing against a stale one"
    );
    assert_eq!(
        store.load_compartments("ses").unwrap().len(),
        0,
        "releasing a parked run publishes nothing"
    );

    // The row is parked, not deleted: it keeps the fingerprint a re-publication
    // would need, and it is no longer offered to anyone.
    let rows = queue_rows(&data_home);
    assert_eq!(
        rows,
        vec![(
            "run-parked".to_string(),
            "ses".to_string(),
            "parked".to_string(),
            None,
            "fp-ses".to_string()
        )],
        "the queue row is parked with the run it belonged to"
    );
    let still_listed =
        call_dispatch_request(&handler, json!({ "method": "historian.pending", "v": 1 })).await;
    assert_eq!(
        still_listed,
        json!({ "ok": true, "runs": [] }),
        "a released run is not advertised to claimants: {still_listed}"
    );
    let refused = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": "run-parked", "claimant_instance_id": "install-one",
        }),
    )
    .await;
    assert_eq!(
        refused,
        json!({ "ok": false, "refusal": "not_pending" }),
        "a claimant that names it anyway is refused, so nothing double-publishes"
    );

    // Inside the run's own deadline the row is still adoptable, so the sweep leaves
    // it alone; past the deadline it is dropped.
    let run_deadline_ms = now + GATE_AWAIT_BUDGET_MS;
    let swept = store.expire_historian_claims(run_deadline_ms - 1).unwrap();
    assert_eq!(swept, mc_store::HistorianSweepOutcome::default());
    assert_eq!(
        queue_rows(&data_home).len(),
        1,
        "a parked run inside its deadline is what a boot-time re-publication adopts"
    );
    let swept = store.expire_historian_claims(run_deadline_ms).unwrap();
    assert_eq!(swept.dropped, vec!["run-parked".to_string()]);
    assert_eq!(
        queue_rows(&data_home).len(),
        0,
        "the sweep reclaims the row rather than leaving it for the session to outlive"
    );
    drop(dir);
}
