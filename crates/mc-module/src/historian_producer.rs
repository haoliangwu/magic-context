//! llm-runner session client used by the historian writer.
//!
//! The client intentionally speaks only the JSON session wire over subc routes. It
//! does not depend on llm-runner Rust crates, so Magic Context remains an origin-
//! agnostic consumer module.

use std::{
    error::Error,
    fmt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use serde::Serialize;
use serde_json::{json, Value};
use subc_control::{ClientControlRequest, ClientControlResponse, ConsumerIdentity};
use subc_protocol::{
    BindIdentity, ErrorBody, Flags, Frame, FrameBuildError, FrameType, Priority, SUBC_MODULE_ID_ENV,
};
use subc_transport::{
    authenticate_client, connection_file, read_frame, write_frame, AuthError, ConnectionFileError,
    FrameIoError,
};
use tokio::net::TcpStream;

use crate::route_targets::{RegisteredRoute, RouteTargetConfig};

/// Output budget for a historian summarization pass. llm-runner's default (4k) truncated
/// a real 50k-input chunk mid-XML on the rig: a tiered compartment doc for a full chunk
/// legitimately needs five figures. The provider clamps to its own per-model limit, so a
/// generous request costs nothing unless the model actually generates that much.
pub(crate) const HISTORIAN_MAX_OUTPUT_TOKENS: u32 = 32_000;

#[derive(Serialize)]
struct GenerationRequest {
    max_output_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
}

/// The `model` object of a `session.send`. Broca decodes it as `{provider, model,
/// variant?}` and freezes the variant (for example a reasoning effort such as `high`)
/// on the run. A typed struct rather than a `json!` object keeps the field order
/// `provider`, `model`, `variant` on the wire, byte-identical to Broca's own send
/// goldens. `variant` is omitted, never sent empty, when the attempt names none.
#[derive(Serialize)]
struct SendModel<'a> {
    provider: &'a str,
    model: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    variant: Option<&'a str>,
}

/// `session.send` params, in Broca's golden field order (`prompt`, `send_id`, `model`)
/// followed by the fields only this client adds. Magic Context never sends `delivery`,
/// so every send is Broca's default queued delivery, which must name its variant
/// explicitly: a queued send does not inherit one from the session.
#[derive(Serialize)]
struct SendParams<'a> {
    prompt: &'a str,
    send_id: &'a str,
    model: SendModel<'a>,
    tools: &'a [Value],
    generation: GenerationRequest,
    #[serde(skip_serializing_if = "str::is_empty")]
    system: &'a str,
}

#[derive(Serialize)]
struct SendRequest<'a> {
    method: &'static str,
    params: SendParams<'a>,
}

/// Build one `session.send` request. `model` is the canonical `provider/model` string,
/// split at the FIRST slash so multi-slash model names keep their remainder intact.
fn session_send_request<'a>(
    send_id: &'a str,
    system: &'a str,
    prompt: &'a str,
    model: &'a str,
    variant: Option<&'a str>,
    max_output_tokens: u32,
    temperature: Option<f64>,
) -> Result<SendRequest<'a>, HistorianProducerError> {
    let (provider, model_name) = model.split_once('/').ok_or_else(|| {
        HistorianProducerError::Subc(ProducerErrorBody::untagged(
            "invalid_model",
            format!("model '{model}' is not in canonical provider/model form"),
        ))
    })?;
    Ok(SendRequest {
        method: "session.send",
        params: SendParams {
            prompt,
            send_id,
            model: SendModel {
                provider,
                model: model_name,
                variant: variant.filter(|variant| !variant.is_empty()),
            },
            tools: &[],
            generation: GenerationRequest {
                max_output_tokens,
                temperature,
            },
            system,
        },
    })
}
const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// How long to wait for a summarization run to finish. A historian pass legitimately
/// generates 10k+ output tokens and can run several minutes on a flash-class model; a
/// 120s window abandoned a run on the rig WHILE it was still successfully finishing
/// (the terminal arrived moments after the waiter gave up). A fold is a background
/// operation, never latency-sensitive: waiting longer and publishing always beats
/// abandoning a completed run and re-firing the whole 50k-input pass.
const DEFAULT_AWAIT_TIMEOUT: Duration = Duration::from_secs(600);
/// How long the timeout recovery path gets to re-drain a run after the main
/// waiter gives up. A completed historian run can land moments after the
/// 600s wait expires; one short replay salvages that durable output without
/// letting the fallback path hang for another full production timeout.
const RECOVERY_REDRAIN_TIMEOUT: Duration = Duration::from_secs(60);

/// Fixed error-class strings used by the producer/consumer wire contract.
pub const ERROR_CLASS_WIRE_SET: [&str; 4] = [
    "transient",
    "permanent",
    "auth_required",
    "context_overflow",
];

/// Runner route-open contract. Message literals identify the reporting stage;
/// typed error classes, when supplied, decide retryability instead of that text.
pub const RUNNER_REFUSAL_OPEN_CODES: [&str; 1] = ["open_failed"];
pub const RUNNER_REFUSAL_OPEN_MESSAGE_LITERALS: [&str; 4] = [
    "run resolution failed",
    "no apikey credential for provider",
    "unknown provider",
    "unknown model",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerRefusalStage {
    Credential,
    Provider,
    Model,
    /// The runner refused route resolution without a more specific credential/catalog literal.
    Resolution,
}

impl RunnerRefusalStage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Credential => "credential",
            Self::Provider => "provider",
            Self::Model => "model",
            Self::Resolution => "resolution",
        }
    }

    pub const fn canonical_cause(self) -> &'static str {
        match self {
            Self::Credential => "credential_unavailable",
            Self::Provider => "provider_unknown",
            Self::Model => "model_unknown",
            Self::Resolution => "runner_resolution_failed",
        }
    }

    pub const fn is_durable(self) -> bool {
        matches!(self, Self::Provider | Self::Model)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerRefusal {
    pub stage: RunnerRefusalStage,
    pub received_code: String,
    pub received_message: String,
    classification: Option<ErrorClassification>,
    class_field_present: bool,
}

impl RunnerRefusal {
    /// Older runners supplied only text. Never let that text override a typed
    /// class, or permanently cache a refusal with an unknown future class.
    pub fn is_durable(&self) -> bool {
        if let Some(classification) = self.classification {
            return classification.class == ErrorClass::Permanent;
        }
        !self.class_field_present && self.stage.is_durable()
    }

    fn from_open_body(body: &ProducerErrorBody) -> Option<Self> {
        if !RUNNER_REFUSAL_OPEN_CODES.contains(&body.code.as_str()) {
            return None;
        }
        let message = body.message.to_ascii_lowercase();
        // Specific stages take precedence because the credential/provider/model messages are
        // commonly nested below the generic "run resolution failed" text.
        let stage = if message.contains(RUNNER_REFUSAL_OPEN_MESSAGE_LITERALS[1]) {
            RunnerRefusalStage::Credential
        } else if message.contains(RUNNER_REFUSAL_OPEN_MESSAGE_LITERALS[2]) {
            RunnerRefusalStage::Provider
        } else if message.contains(RUNNER_REFUSAL_OPEN_MESSAGE_LITERALS[3]) {
            RunnerRefusalStage::Model
        } else {
            RunnerRefusalStage::Resolution
        };
        Some(Self {
            stage,
            received_code: body.code.clone(),
            received_message: body.message.clone(),
            classification: body.classification(),
            class_field_present: body.has_class_field(),
        })
    }
}

static DEPRECATED_HEURISTIC_USES: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    Transient,
    Permanent,
    AuthRequired,
    ContextOverflow,
}

impl ErrorClass {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            ErrorClass::Transient => ERROR_CLASS_WIRE_SET[0],
            ErrorClass::Permanent => ERROR_CLASS_WIRE_SET[1],
            ErrorClass::AuthRequired => ERROR_CLASS_WIRE_SET[2],
            ErrorClass::ContextOverflow => ERROR_CLASS_WIRE_SET[3],
        }
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "transient" => Some(ErrorClass::Transient),
            "permanent" => Some(ErrorClass::Permanent),
            "auth_required" | "auth" => Some(ErrorClass::AuthRequired),
            "context_overflow" => Some(ErrorClass::ContextOverflow),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErrorClassification {
    pub class: ErrorClass,
    pub retry_after_secs: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProducerErrorBody {
    pub code: String,
    pub message: String,
    classification: Option<ErrorClassification>,
    class_field_present: bool,
    retry_metadata: Option<Value>,
}

impl ProducerErrorBody {
    pub fn untagged(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            classification: None,
            class_field_present: false,
            retry_metadata: None,
        }
    }

    pub fn tagged(
        code: impl Into<String>,
        message: impl Into<String>,
        class: ErrorClass,
        retry_after_secs: Option<u64>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            classification: Some(ErrorClassification {
                class,
                retry_after_secs,
            }),
            class_field_present: true,
            retry_metadata: None,
        }
    }

    pub fn classification(&self) -> Option<ErrorClassification> {
        self.classification
    }

    pub fn has_class_field(&self) -> bool {
        self.class_field_present
    }

    fn from_value(value: Value) -> Self {
        let code = value
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("producer_error")
            .to_string();
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("producer error")
            .to_string();
        // Broca route-open failures carry their class in detail, not at the
        // top level used by ordinary producer errors. Absent detail.class keeps
        // the legacy message-based decision; unknown present classes do not.
        let class_source = if code == "open_failed" {
            value.get("detail").unwrap_or(&Value::Null)
        } else {
            &value
        };
        let (classification, class_field_present) = classification_from_object(class_source);
        Self {
            code,
            message,
            classification,
            class_field_present,
            retry_metadata: Some(value),
        }
    }
}

impl From<ErrorBody> for ProducerErrorBody {
    fn from(body: ErrorBody) -> Self {
        Self::untagged(body.code, body.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DeprecatedHeuristicDecision {
    pub retryable_model_failure: bool,
    pub abort_or_overflow: bool,
}

pub fn deprecated_heuristic_uses() -> u64 {
    DEPRECATED_HEURISTIC_USES.load(Ordering::Relaxed)
}

#[cfg(test)]
pub(crate) fn reset_deprecated_heuristic_uses_for_test() {
    DEPRECATED_HEURISTIC_USES.store(0, Ordering::Relaxed);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunHandle {
    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProducerOutput {
    pub text: String,
    /// True when any unit in the run reported a length-class finish reason. The run
    /// terminal can still say completed while a model step hit its output ceiling and
    /// cut the text mid-document, so validation failures need this to self-diagnose.
    pub length_capped: bool,
    /// Provider token spend for the run, when the runner reported any. `None` means
    /// nothing was reported, not a zero-cost run.
    pub usage: Option<ProducerUsage>,
}

/// Token spend for one producer run, summed over its model steps. Field meanings follow
/// the runner's usage record: `input` is fresh (non-cached) input, `cache_read` and
/// `cache_write` are the cached-input hit and cache-creation counts, and `output`
/// already includes any reasoning tokens.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProducerUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

pub(crate) fn producer_token_log(
    usage: Option<ProducerUsage>,
    max_tokens: Option<u32>,
    length_capped: bool,
) -> Value {
    serde_json::json!({
        "input": usage.map(|value| value.input),
        "output": usage.map(|value| value.output),
        "reasoning": None::<u64>,
        "cache_read": usage.map(|value| value.cache_read),
        "cache_write": usage.map(|value| value.cache_write),
        "max_tokens": max_tokens,
        "finish_reason": if length_capped { Some("length") } else { None },
    })
}

impl ProducerUsage {
    /// Reads a runner usage object (`input_tokens`, `output_tokens`,
    /// `cached_input_tokens`, `cache_write_tokens`; each optional). Returns `None` when
    /// the value is not an object.
    fn from_runner_usage(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let field = |name: &str| object.get(name).and_then(Value::as_u64).unwrap_or(0);
        Some(Self {
            input: field("input_tokens"),
            output: field("output_tokens"),
            cache_read: field("cached_input_tokens"),
            cache_write: field("cache_write_tokens"),
        })
    }

    fn add(&mut self, other: Self) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
        self.cache_write = self.cache_write.saturating_add(other.cache_write);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunState {
    Terminal,
    Active,
    Missing { detail: Option<String> },
}

#[derive(Debug, Clone)]
pub struct HistorianProducerConfig {
    pub connection_file: PathBuf,
    pub project_root: PathBuf,
    pub harness: String,
    pub route_targets: RouteTargetConfig,
    pub handshake_timeout: Duration,
    pub request_timeout: Duration,
    pub await_timeout: Duration,
}

impl HistorianProducerConfig {
    pub fn new(
        connection_file: impl Into<PathBuf>,
        project_root: impl Into<PathBuf>,
        harness: impl Into<String>,
    ) -> Self {
        Self {
            connection_file: connection_file.into(),
            project_root: project_root.into(),
            harness: harness.into(),
            route_targets: RouteTargetConfig::default(),
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            await_timeout: DEFAULT_AWAIT_TIMEOUT,
        }
    }
}

#[derive(Debug)]
pub enum HistorianProducerError {
    ConnectionFile {
        path: PathBuf,
        source: ConnectionFileError,
    },
    NoEndpoint {
        path: PathBuf,
    },
    Connect {
        endpoint: String,
        source: std::io::Error,
    },
    Auth(AuthError),
    FrameIo(FrameIoError),
    FrameBuild(FrameBuildError),
    Json(serde_json::Error),
    Subc(ProducerErrorBody),
    UnexpectedControlResponse,
    MissingRunId,
    /// The send was accepted but did not start a run: the lineage already had an active
    /// run, so the prompt was durably queued behind it under `submission_id`.
    SendQueued {
        submission_id: String,
        /// Whether the queued submission was withdrawn again. A submission left standing
        /// eventually runs a model call whose output no one is waiting for.
        retracted: bool,
    },
    MissingSession,
    RunnerSessionDeletionUnsupported {
        session_id: String,
    },
    HostRunnerRequiresHostTransport,
    UnexpectedStreamEnd,
    TimedOut,
    RunFailed {
        run_id: String,
        detail: String,
        classification: Option<ErrorClassification>,
        class_field_present: bool,
    },
    TerminalRunMismatch {
        expected: String,
        found: Option<String>,
    },
    RunPaused {
        run_id: String,
        reason: Option<String>,
        classification: Option<ErrorClassification>,
        class_field_present: bool,
    },
}

impl HistorianProducerError {
    /// Provider reset metadata is a retry hint, never an error-class override.
    pub(crate) fn provider_retry_at_ms(&self, now_ms: i64) -> Option<i64> {
        let (metadata, text) = match self {
            Self::Subc(body) => (body.retry_metadata.as_ref(), body.message.as_str()),
            Self::RunFailed { detail, .. } => (None, detail.as_str()),
            Self::RunPaused { reason, .. } => (None, reason.as_deref().unwrap_or("")),
            _ => return None,
        };
        metadata
            .and_then(|value| provider_retry_at_ms(value, now_ms, 0))
            .or_else(|| provider_retry_at_ms(&Value::String(text.to_string()), now_ms, 0))
            .or_else(|| {
                let seconds = self.classification()?.retry_after_secs?;
                let delay_ms = seconds.saturating_mul(1000).min(i64::MAX as u64) as i64;
                Some(
                    now_ms.saturating_add(
                        delay_ms.max(crate::historian::HISTORIAN_FAILURE_BACKOFF_MS),
                    ),
                )
            })
    }

    pub fn retryable_model_failure(message: impl Into<String>) -> Self {
        HistorianProducerError::Subc(ProducerErrorBody::untagged(
            "retryable_model_failure",
            message,
        ))
    }

    pub fn context_overflow(message: impl Into<String>) -> Self {
        HistorianProducerError::Subc(ProducerErrorBody::untagged("context_overflow", message))
    }

    pub fn aborted(message: impl Into<String>) -> Self {
        HistorianProducerError::Subc(ProducerErrorBody::untagged("aborted", message))
    }

    pub fn tagged_subc(
        code: impl Into<String>,
        message: impl Into<String>,
        class: ErrorClass,
        retry_after_secs: Option<u64>,
    ) -> Self {
        HistorianProducerError::Subc(ProducerErrorBody::tagged(
            code,
            message,
            class,
            retry_after_secs,
        ))
    }

    pub fn classification(&self) -> Option<ErrorClassification> {
        match self {
            HistorianProducerError::Subc(body) => body.classification(),
            HistorianProducerError::RunFailed { classification, .. }
            | HistorianProducerError::RunPaused { classification, .. } => *classification,
            // A busy lineage clears once its active run ends, so a queued send is always
            // worth retrying. This is a fact about the response, not a parsed hint.
            HistorianProducerError::SendQueued { .. } => Some(ErrorClassification {
                class: ErrorClass::Transient,
                retry_after_secs: None,
            }),
            _ => None,
        }
    }

    pub fn has_class_field(&self) -> bool {
        match self {
            HistorianProducerError::Subc(body) => body.has_class_field(),
            HistorianProducerError::RunFailed {
                class_field_present,
                ..
            }
            | HistorianProducerError::RunPaused {
                class_field_present,
                ..
            } => *class_field_present,
            _ => false,
        }
    }

    pub(crate) fn deprecated_heuristic_decision(&self) -> DeprecatedHeuristicDecision {
        record_deprecated_heuristic_use(self.heuristic_log_code());
        self.heuristic_decision()
    }

    pub fn is_retryable_model_failure(&self) -> bool {
        if let Some(classification) = self.classification() {
            return classification.class == ErrorClass::Transient;
        }
        if self.has_class_field() {
            return false;
        }
        self.heuristic_decision().retryable_model_failure
    }

    pub fn is_abort_or_overflow(&self) -> bool {
        if let Some(classification) = self.classification() {
            return classification.class == ErrorClass::ContextOverflow;
        }
        if self.has_class_field() {
            return false;
        }
        self.heuristic_decision().abort_or_overflow
    }

    pub fn is_unknown_module(&self) -> bool {
        matches!(
            self,
            HistorianProducerError::Subc(body) if body.code == "unknown_module"
        )
    }

    /// Parse a route-open refusal while preserving the runner's code and message verbatim.
    pub fn runner_refusal(&self) -> Option<RunnerRefusal> {
        let HistorianProducerError::Subc(body) = self else {
            return None;
        };
        RunnerRefusal::from_open_body(body)
    }

    fn heuristic_decision(&self) -> DeprecatedHeuristicDecision {
        match self {
            HistorianProducerError::Subc(body) => DeprecatedHeuristicDecision {
                retryable_model_failure: retryable_code(&body.code)
                    || retryable_code(&body.message),
                abort_or_overflow: abort_or_overflow(&body.code)
                    || abort_or_overflow(&body.message),
            },
            HistorianProducerError::RunFailed { detail, .. } => DeprecatedHeuristicDecision {
                retryable_model_failure: retryable_code(detail),
                abort_or_overflow: abort_or_overflow(detail),
            },
            _ => DeprecatedHeuristicDecision {
                retryable_model_failure: false,
                abort_or_overflow: false,
            },
        }
    }

    fn heuristic_log_code(&self) -> &str {
        match self {
            HistorianProducerError::Subc(body) => &body.code,
            HistorianProducerError::RunFailed { .. } => "run_failed",
            HistorianProducerError::RunPaused { .. } => "run_paused",
            HistorianProducerError::SendQueued { .. } => "send_queued",
            HistorianProducerError::TimedOut => "timed_out",
            _ => "producer_error",
        }
    }
}

fn record_deprecated_heuristic_use(code: &str) {
    DEPRECATED_HEURISTIC_USES.fetch_add(1, Ordering::Relaxed);
    tracing::error!("[mc-module] untagged producer error (deprecated heuristic used): code={code}");
}

fn retryable_code(s: &str) -> bool {
    let s = s.to_ascii_lowercase();
    s.contains("retry")
        || s.contains("transient")
        || s.contains("rate_limit")
        || s.contains("quota_exhausted")
        || s.trim() == "429"
        || s.contains("provider_unavailable")
        || s.contains("overloaded")
}

fn abort_or_overflow(s: &str) -> bool {
    let s = s.to_ascii_lowercase();
    s.contains("abort")
        || s.contains("cancel")
        || s.contains("context_overflow")
        || s.contains("overflow")
}

impl fmt::Display for HistorianProducerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HistorianProducerError::ConnectionFile { path, source } => {
                write!(f, "read connection file {}: {source}", path.display())
            }
            HistorianProducerError::NoEndpoint { path } => {
                write!(f, "connection file {} has no endpoint", path.display())
            }
            HistorianProducerError::Connect { endpoint, source } => {
                write!(f, "connect to {endpoint}: {source}")
            }
            HistorianProducerError::Auth(e) => write!(f, "authenticate to subc: {e}"),
            HistorianProducerError::FrameIo(e) => write!(f, "subc frame I/O: {e}"),
            HistorianProducerError::FrameBuild(e) => write!(f, "build subc frame: {e}"),
            HistorianProducerError::Json(e) => write!(f, "json: {e}"),
            HistorianProducerError::Subc(body) => {
                write!(f, "subc error {}: {}", body.code, body.message)
            }
            HistorianProducerError::UnexpectedControlResponse => {
                write!(f, "route.open returned an unexpected control response")
            }
            HistorianProducerError::MissingRunId => {
                write!(f, "session.send did not return an active run_id")
            }
            HistorianProducerError::SendQueued {
                submission_id,
                retracted,
            } => write!(
                f,
                "session.send queued this prompt behind the run already active on the session (submission {submission_id}, retracted: {})",
                if *retracted { "yes" } else { "no" }
            ),
            HistorianProducerError::MissingSession => {
                write!(f, "historian producer has no bound session")
            }
            HistorianProducerError::RunnerSessionDeletionUnsupported { session_id } => write!(
                f,
                "runner cannot delete session {session_id}; Broca never deletes sessions, so it stays in Broca's store indefinitely"
            ),
            HistorianProducerError::HostRunnerRequiresHostTransport => {
                write!(f, "host historian runner does not use a subc module route")
            }
            HistorianProducerError::UnexpectedStreamEnd => write!(
                f,
                "subscribe stream ended before the run terminal control unit"
            ),
            HistorianProducerError::TimedOut => write!(f, "historian producer timed out"),
            HistorianProducerError::RunFailed { run_id, detail, .. } => {
                write!(f, "run {run_id} failed: {detail}")
            }
            HistorianProducerError::TerminalRunMismatch { expected, found } => {
                write!(
                    f,
                    "run {expected} received terminal control unit after RunStarted {:?}",
                    found
                )
            }
            HistorianProducerError::RunPaused { run_id, reason, .. } => {
                write!(f, "run {run_id} paused")?;
                if let Some(reason) = reason {
                    write!(f, ": {reason}")?;
                }
                Ok(())
            }
        }
    }
}

impl Error for HistorianProducerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            HistorianProducerError::ConnectionFile { source, .. } => Some(source),
            HistorianProducerError::Connect { source, .. } => Some(source),
            HistorianProducerError::Auth(e) => Some(e),
            HistorianProducerError::FrameIo(e) => Some(e),
            HistorianProducerError::FrameBuild(e) => Some(e),
            HistorianProducerError::Json(e) => Some(e),
            HistorianProducerError::NoEndpoint { .. }
            | HistorianProducerError::Subc(_)
            | HistorianProducerError::UnexpectedControlResponse
            | HistorianProducerError::MissingRunId
            | HistorianProducerError::SendQueued { .. }
            | HistorianProducerError::MissingSession
            | HistorianProducerError::RunnerSessionDeletionUnsupported { .. }
            | HistorianProducerError::HostRunnerRequiresHostTransport
            | HistorianProducerError::UnexpectedStreamEnd
            | HistorianProducerError::TimedOut
            | HistorianProducerError::RunFailed { .. }
            | HistorianProducerError::TerminalRunMismatch { .. }
            | HistorianProducerError::RunPaused { .. } => None,
        }
    }
}

impl From<FrameIoError> for HistorianProducerError {
    fn from(e: FrameIoError) -> Self {
        HistorianProducerError::FrameIo(e)
    }
}

impl From<FrameBuildError> for HistorianProducerError {
    fn from(e: FrameBuildError) -> Self {
        HistorianProducerError::FrameBuild(e)
    }
}

impl From<serde_json::Error> for HistorianProducerError {
    fn from(e: serde_json::Error) -> Self {
        HistorianProducerError::Json(e)
    }
}

/// The daemon-assigned identity of an open consumer route.
///
/// This raw client cannot construct `subc_client_rs::RouteHandle` because that type also
/// fences SDK-managed connections. It retains the serializable wire identity needed to
/// stamp every data-plane frame and reject stale replies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OpenedRoute {
    channel: u16,
    epoch: u32,
}

pub struct HistorianProducer {
    config: HistorianProducerConfig,
    stream: TcpStream,
    next_corr: u64,
    session_id: Option<String>,
    command_route: Option<OpenedRoute>,
    subscribe_route: Option<OpenedRoute>,
}

impl HistorianProducer {
    pub async fn connect(config: HistorianProducerConfig) -> Result<Self, HistorianProducerError> {
        let conn = connection_file::read(&config.connection_file).map_err(|source| {
            HistorianProducerError::ConnectionFile {
                path: config.connection_file.clone(),
                source,
            }
        })?;
        let endpoint =
            conn.endpoints
                .first()
                .ok_or_else(|| HistorianProducerError::NoEndpoint {
                    path: config.connection_file.clone(),
                })?;
        let endpoint_label = format!("{}:{}", endpoint.host, endpoint.port);
        let mut stream = TcpStream::connect(&endpoint_label)
            .await
            .map_err(|source| HistorianProducerError::Connect {
                endpoint: endpoint_label,
                source,
            })?;
        authenticate_client(&mut stream, &conn, config.handshake_timeout)
            .await
            .map_err(HistorianProducerError::Auth)?;
        Ok(Self {
            config,
            stream,
            next_corr: 1,
            session_id: None,
            command_route: None,
            subscribe_route: None,
        })
    }

    /// Bind subsequent status/subscribe/cancel calls to an existing session. Reattach
    /// probes open the route with the persisted session id and must not call send again.
    pub fn bind_session(&mut self, session_id: impl Into<String>) {
        self.session_id = Some(session_id.into());
    }

    pub async fn start(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
    ) -> Result<RunHandle, HistorianProducerError> {
        self.start_with_generation(
            session_id,
            system,
            prompt,
            model,
            None,
            HISTORIAN_MAX_OUTPUT_TOKENS,
            None,
        )
        .await
    }

    pub async fn start_with_temperature(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
        variant: Option<&str>,
        temperature: Option<f64>,
    ) -> Result<RunHandle, HistorianProducerError> {
        self.start_with_generation(
            session_id,
            system,
            prompt,
            model,
            variant,
            HISTORIAN_MAX_OUTPUT_TOKENS,
            temperature,
        )
        .await
    }

    /// `variant` is the host-configured model variant for this attempt's model (for
    /// example an OpenCode reasoning variant). It rides `model.variant`; `None` omits it.
    #[allow(clippy::too_many_arguments)] // Each value is a distinct field of one send.
    pub async fn start_with_generation(
        &mut self,
        session_id: &str,
        system: &str,
        prompt: &str,
        model: &str,
        variant: Option<&str>,
        max_output_tokens: u32,
        temperature: Option<f64>,
    ) -> Result<RunHandle, HistorianProducerError> {
        self.bind_session(session_id.to_string());
        let route = self.ensure_command_route().await?;
        // The route identity is the session. Keeping `session` out of this body avoids
        // a second, diverging source of truth for the run lineage.
        //
        // `system` rides the role-scoped SendParams.system field (delivered as a leading
        // system message in the run's durable input, byte-exact) — NEVER concatenated
        // into the user prompt: the historian's parse/validate contract assumes the
        // model saw its role guidance as a system message. Empty means absent, matching
        // the wire's empty-as-absent rule, so we omit the field entirely.
        //
        // The params shape mirrors llm-runner's SendParams (llmr-module-serve wire.rs):
        // `model` is a nested {provider, model, variant?} object. The server decodes
        // strictly enough that a flat model string fails the whole send with
        // invalid_params, which a live rig drive surfaced as firings dying before any
        // producer run existed.
        //
        // Each historian firing (including model fallbacks) and dreamer attempt owns
        // a distinct session id. Use that durable attempt identity as `send_id`, not a
        // connection nonce or frame correlation id: resending after a lost reply must
        // deduplicate, while a new attempt after a classified failure must start a new run.
        let body = session_send_request(
            session_id,
            system,
            prompt,
            model,
            variant,
            max_output_tokens,
            temperature,
        )?;
        let response = self.unary_json(route, body).await?;
        match send_outcome(&response) {
            SendOutcome::Active(run_id) => Ok(RunHandle { run_id }),
            SendOutcome::Queued(submission_id) => {
                // The prompt was ACCEPTED, not rejected: the run this producer wanted is
                // sitting in the lineage's queue. Nothing here will ever drain it — this
                // producer only subscribes to a run it started — so withdraw it rather
                // than leave a model call to fire for output no one is waiting for.
                let retracted = self.retract(route, &submission_id).await.is_ok();
                Err(HistorianProducerError::SendQueued {
                    submission_id,
                    retracted,
                })
            }
            SendOutcome::Unrecognized => Err(HistorianProducerError::MissingRunId),
        }
    }

    /// Withdraw a queued submission. Best effort: a submission the server has already
    /// consumed, or a server without the operation, is reported by the caller as such.
    async fn retract(
        &mut self,
        route: OpenedRoute,
        submission_id: &str,
    ) -> Result<(), HistorianProducerError> {
        let _ = self
            .unary_json(
                route,
                json!({
                    "method": "session.retract",
                    "params": { "submission_id": submission_id }
                }),
            )
            .await?;
        Ok(())
    }

    pub async fn await_output(
        &mut self,
        run_id: &str,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        self.await_output_with_timeout(run_id, self.config.await_timeout)
            .await
    }

    pub async fn await_output_with_timeout(
        &mut self,
        run_id: &str,
        timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        self.subscribe_from_start(run_id, timeout).await
    }

    pub async fn redrain_output(
        &mut self,
        run_id: &str,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        self.redrain_output_with_timeout(run_id, RECOVERY_REDRAIN_TIMEOUT)
            .await
    }

    pub async fn redrain_output_with_timeout(
        &mut self,
        run_id: &str,
        timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        self.subscribe_from_start(run_id, timeout).await
    }

    pub async fn status(&mut self, run_id: &str) -> Result<RunState, HistorianProducerError> {
        let route = self.ensure_command_route().await?;
        let response = self
            .unary_json(
                route,
                json!({ "method": "run.status", "params": { "run_id": run_id } }),
            )
            .await?;
        Ok(classify_run_state(run_id, &response))
    }

    pub async fn cancel(&mut self, run_id: &str) -> Result<(), HistorianProducerError> {
        let route = self.ensure_command_route().await?;
        let _ = self
            .unary_json(
                route,
                json!({ "method": "run.cancel", "params": { "run_id": run_id } }),
            )
            .await?;
        Ok(())
    }

    /// Release routes, but report that the runner cannot delete session data.
    /// Dreamer sessions contain memory-pool snapshots; closing a route does not
    /// remove those snapshots from Broca's append-only write-ahead log.
    pub async fn purge_session(&mut self, session_id: &str) -> Result<(), HistorianProducerError> {
        self.close().await;
        static RETENTION_WARNING: std::sync::Once = std::sync::Once::new();
        RETENTION_WARNING.call_once(|| {
            tracing::warn!("[mc-module] runner cannot delete sessions: Broca has no session.delete operation and never deletes a session. Its write-ahead log is append-only, an idle session is moved into an archive byte for byte after 7 days and kept, and engram backs both up. Dreamer memory-pool snapshots sent to the runner therefore stay indefinitely; closing routes does not delete them.");
        });
        Err(HistorianProducerError::RunnerSessionDeletionUnsupported {
            session_id: session_id.to_string(),
        })
    }

    pub async fn close(&mut self) {
        if let Some(route) = self.subscribe_route.take() {
            let _ = self.send_goodbye(route).await;
        }
        if let Some(route) = self.command_route.take() {
            let _ = self.send_goodbye(route).await;
        }
    }

    async fn subscribe_from_start(
        &mut self,
        run_id: &str,
        timeout: Duration,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        let route = self.ensure_subscribe_route().await?;
        // Subscribe from "start" instead of a cursor. Replay after a cursor is
        // exclusive, so persisting an advancing cursor can drop units at or before
        // it on reattach. Re-draining from the start is safe because validation
        // and compare-and-swap checks during publish are idempotent.
        let body = json!({ "method": "session.subscribe", "params": { "from": "start" } });
        let corr = self.send_request(route, body).await?;
        match tokio::time::timeout(timeout, self.drain_subscribe(route, corr, run_id)).await {
            Ok(result) => result,
            Err(_) => Err(HistorianProducerError::TimedOut),
        }
    }

    async fn ensure_command_route(&mut self) -> Result<OpenedRoute, HistorianProducerError> {
        if let Some(route) = self.command_route {
            return Ok(route);
        }
        let route = self.open_bound_route().await?;
        self.command_route = Some(route);
        Ok(route)
    }

    async fn ensure_subscribe_route(&mut self) -> Result<OpenedRoute, HistorianProducerError> {
        if let Some(route) = self.subscribe_route {
            return Ok(route);
        }
        let route = self.open_bound_route().await?;
        self.subscribe_route = Some(route);
        Ok(route)
    }

    async fn open_bound_route(&mut self) -> Result<OpenedRoute, HistorianProducerError> {
        let session = self
            .session_id
            .clone()
            .ok_or(HistorianProducerError::MissingSession)?;
        let target = self
            .config
            .route_targets
            .target(RegisteredRoute::HistorianRunner)
            .ok_or(HistorianProducerError::HostRunnerRequiresHostTransport)?;
        let request = ClientControlRequest::RouteOpen {
            target,
            identity: BindIdentity::new(
                self.config.project_root.clone(),
                self.config.harness.clone(),
                session,
            ),
            consumer_identity: consumer_identity_from_launch(),
            consumer_capabilities: None,
            admission_facts: None,
            // Historian routes carry no session scope; they run under the module's own identity.
            scope: None,
            // The historian runner is not a versioned role route.
            role_versions: None,
        };
        let corr = self.next_corr();
        let body = serde_json::to_vec(&request)?;
        self.write_frame(FrameType::Request, 0, 0, corr, body)
            .await?;
        let frame = self
            .read_terminal_for(
                OpenedRoute {
                    channel: 0,
                    epoch: 0,
                },
                corr,
                self.config.request_timeout,
            )
            .await?;
        match frame.header.ty {
            FrameType::Response => {
                let response: ClientControlResponse = serde_json::from_slice(&frame.body)?;
                if let ClientControlResponse::RouteOpen {
                    route_channel,
                    route_epoch,
                } = response
                {
                    Ok(OpenedRoute {
                        channel: route_channel,
                        epoch: route_epoch,
                    })
                } else {
                    Err(HistorianProducerError::UnexpectedControlResponse)
                }
            }
            FrameType::Error => Err(HistorianProducerError::Subc(error_body(&frame.body))),
            _ => Err(HistorianProducerError::UnexpectedControlResponse),
        }
    }

    async fn unary_json(
        &mut self,
        route: OpenedRoute,
        body: impl Serialize + Send,
    ) -> Result<Value, HistorianProducerError> {
        let corr = self.send_request(route, body).await?;
        let frame = self
            .read_terminal_for(route, corr, self.config.request_timeout)
            .await?;
        match frame.header.ty {
            FrameType::Response => Ok(serde_json::from_slice(&frame.body)?),
            FrameType::StreamEnd => Ok(Value::Null),
            FrameType::Error => Err(HistorianProducerError::Subc(error_body(&frame.body))),
            _ => Err(HistorianProducerError::UnexpectedControlResponse),
        }
    }

    async fn send_request(
        &mut self,
        route: OpenedRoute,
        body: impl Serialize + Send,
    ) -> Result<u64, HistorianProducerError> {
        let corr = self.next_corr();
        let bytes = serde_json::to_vec(&body)?;
        self.write_frame(FrameType::Request, route.channel, route.epoch, corr, bytes)
            .await?;
        Ok(corr)
    }

    async fn drain_subscribe(
        &mut self,
        route: OpenedRoute,
        corr: u64,
        run_id: &str,
    ) -> Result<ProducerOutput, HistorianProducerError> {
        let mut text = String::new();
        let mut last_run_started: Option<String> = None;
        let mut length_capped = false;
        // The runner reports each model step's usage on its `step_finished` unit, never
        // a running total, so the run's spend is their sum. The terminal's own `usage`
        // is only used when no step unit carried any (for example an older runner).
        let mut step_usage: Option<ProducerUsage> = None;
        loop {
            let Some(frame) = read_frame(&mut self.stream).await? else {
                return Err(HistorianProducerError::UnexpectedStreamEnd);
            };
            if frame.header.channel != route.channel
                || frame.header.epoch != route.epoch
                || frame.header.corr != corr
            {
                continue;
            }
            match frame.header.ty {
                FrameType::StreamData => {
                    let event: Value = serde_json::from_slice(&frame.body)?;
                    let Some(unit) = control_unit(&event) else {
                        continue;
                    };
                    if is_run_started_unit(unit) {
                        last_run_started = unit_run_id(unit).map(ToString::to_string);
                    }
                    let terminal = is_terminal_unit(unit);
                    if !terminal && unit_run_id(unit).is_some_and(|id| id != run_id) {
                        continue;
                    }
                    if is_paused_unit(unit) && unit_run_id(unit) == Some(run_id) {
                        // A paused run still holds the slot for this historian. Return
                        // an error so callers stop waiting and retry later instead of
                        // hanging forever on a run that is paused but not finished.
                        let info = unit_error_info(unit);
                        return Err(HistorianProducerError::RunPaused {
                            run_id: run_id.to_string(),
                            reason: paused_reason(unit).map(ToString::to_string),
                            classification: info.classification,
                            class_field_present: info.class_field_present,
                        });
                    }
                    if let Some(piece) = unit_text(unit) {
                        text.push_str(&piece);
                    }
                    if unit_is_length_capped(unit) {
                        length_capped = true;
                    }
                    if is_step_finished_unit(unit) {
                        if let Some(usage) =
                            unit.get("usage").and_then(ProducerUsage::from_runner_usage)
                        {
                            step_usage
                                .get_or_insert_with(ProducerUsage::default)
                                .add(usage);
                        }
                    }
                    if terminal {
                        if last_run_started.as_deref() != Some(run_id) {
                            return Err(HistorianProducerError::TerminalRunMismatch {
                                expected: run_id.to_string(),
                                found: last_run_started,
                            });
                        }
                        if is_error_unit(unit) {
                            let info = unit_error_info(unit);
                            return Err(HistorianProducerError::RunFailed {
                                run_id: run_id.to_string(),
                                detail: info.detail.unwrap_or_else(|| "run failed".to_string()),
                                classification: info.classification,
                                class_field_present: info.class_field_present,
                            });
                        }
                        // The run terminal control unit is authoritative. StreamEnd is only
                        // route mechanics and can appear on detach/resubscribe without ending a run.
                        let usage = step_usage.or_else(|| {
                            unit.get("usage").and_then(ProducerUsage::from_runner_usage)
                        });
                        return Ok(ProducerOutput {
                            text,
                            length_capped,
                            usage,
                        });
                    }
                }
                FrameType::Error => {
                    return Err(HistorianProducerError::Subc(error_body(&frame.body)))
                }
                FrameType::StreamEnd => return Err(HistorianProducerError::UnexpectedStreamEnd),
                _ => {}
            }
        }
    }

    async fn read_terminal_for(
        &mut self,
        route: OpenedRoute,
        corr: u64,
        timeout: Duration,
    ) -> Result<Frame, HistorianProducerError> {
        match tokio::time::timeout(timeout, async {
            loop {
                let Some(frame) = read_frame(&mut self.stream).await? else {
                    return Err(HistorianProducerError::UnexpectedStreamEnd);
                };
                if frame.header.channel == route.channel
                    && frame.header.epoch == route.epoch
                    && frame.header.corr == corr
                {
                    return Ok(frame);
                }
            }
        })
        .await
        {
            Ok(result) => result,
            Err(_) => Err(HistorianProducerError::TimedOut),
        }
    }

    async fn write_frame(
        &mut self,
        ty: FrameType,
        channel: u16,
        epoch: u32,
        corr: u64,
        body: Vec<u8>,
    ) -> Result<(), HistorianProducerError> {
        let frame = Frame::build(
            ty,
            Flags::new(false, Priority::Interactive, false),
            channel,
            epoch,
            corr,
            body,
        )?;
        write_frame(&mut self.stream, &frame).await?;
        Ok(())
    }

    async fn send_goodbye(&mut self, route: OpenedRoute) -> Result<(), HistorianProducerError> {
        let frame = Frame::build(
            FrameType::Goodbye,
            Flags::new(false, Priority::Interactive, false),
            route.channel,
            route.epoch,
            0,
            Vec::new(),
        )?;
        write_frame(&mut self.stream, &frame).await?;
        Ok(())
    }

    fn next_corr(&mut self) -> u64 {
        let corr = self.next_corr;
        self.next_corr = self.next_corr.saturating_add(1).max(1);
        corr
    }
}

impl Drop for HistorianProducer {
    fn drop(&mut self) {
        // Async close is preferred by callers; drop only releases the TCP socket.
    }
}

/// What a `session.send` reply actually said.
#[derive(Debug, PartialEq, Eq)]
enum SendOutcome {
    /// The session was idle and this run started.
    Active(String),
    /// The session was busy; the prompt is durably queued under this submission id.
    Queued(String),
    /// Neither shape — the reply carries no run and names no submission.
    Unrecognized,
}

/// Decode a `session.send` reply.
///
/// The runner answers with a `state`-tagged result inside a `result` envelope: `active`
/// carries the run that started, `pending` means the session already had an active run and
/// this prompt was durably QUEUED behind it under a submission id. Reading only `run_id`
/// collapses those two into "no run id", which reports a queued (accepted) prompt as a
/// malformed reply and hides the one fact that explains it — the session was busy.
fn send_outcome(response: &Value) -> SendOutcome {
    let body = match response.get("result") {
        Some(result) if result.is_object() => result,
        _ => response,
    };
    if let Some(run_id) = body.get("run_id").and_then(Value::as_str) {
        return SendOutcome::Active(run_id.to_string());
    }
    let pending = body
        .get("state")
        .and_then(Value::as_str)
        .is_some_and(|state| state.eq_ignore_ascii_case("pending"));
    match body.get("submission_id").and_then(Value::as_str) {
        Some(submission_id) if pending => SendOutcome::Queued(submission_id.to_string()),
        _ => SendOutcome::Unrecognized,
    }
}

fn classify_run_state(run_id: &str, value: &Value) -> RunState {
    let value = value.get("result").unwrap_or(value);
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let response_run_id = value.get("run_id").and_then(Value::as_str);
    if response_run_id.is_some_and(|id| id != run_id) {
        return RunState::Missing {
            detail: Some("run.status returned a different run_id".to_string()),
        };
    }
    if state.contains("terminal")
        || state.contains("interrupted")
        || state == "completed"
        || state == "finished"
    {
        RunState::Terminal
    } else if state.contains("active")
        || state.contains("paused")
        || state.contains("pending")
        || state.contains("running")
    {
        RunState::Active
    } else if state.contains("error") {
        RunState::Missing {
            detail: value
                .get("last_error")
                .or_else(|| value.get("detail"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
        }
    } else {
        RunState::Missing {
            detail: Some(state),
        }
    }
}

fn control_unit(event: &Value) -> Option<&Value> {
    let kind = event.get("kind").and_then(Value::as_str);
    if kind == Some("display") {
        return None;
    }
    if kind == Some("control") {
        let unit = event.get("unit").unwrap_or(event);
        return Some(unit);
    }
    Some(event.get("unit").unwrap_or(event))
}

fn unit_type(unit: &Value) -> Option<&str> {
    unit.get("type")
        .or_else(|| unit.get("kind"))
        .and_then(Value::as_str)
}

fn unit_run_id(unit: &Value) -> Option<&str> {
    unit.get("run_id")
        .or_else(|| unit.get("runId"))
        .and_then(Value::as_str)
}

/// Extract the assistant TEXT from a control unit. llm-runner's assistant_message
/// unit nests an assembled message with a content-block array; only `text` blocks are
/// the historian's output. `reasoning` blocks are deliberately EXCLUDED: a reasoning
/// model's thinking legitimately restates the prompt's format template and walks the
/// seed examples, so folding it into the output would corrupt the parse with
/// template/seed prose. Flat `text`/`content` fields are kept as a fallback for
/// simpler unit shapes.
fn unit_text(unit: &Value) -> Option<String> {
    if !unit_type(unit).is_some_and(|ty| ty.eq_ignore_ascii_case("assistant_message")) {
        return None;
    }
    if let Some(blocks) = unit
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    {
        let text: String = blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect();
        return (!text.is_empty()).then_some(text);
    }
    unit.get("text")
        .or_else(|| unit.get("content"))
        .or_else(|| unit.get("message").and_then(|m| m.get("text")))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn is_terminal_unit(unit: &Value) -> bool {
    let Some(ty) = unit_type(unit).map(str::to_ascii_lowercase) else {
        return false;
    };
    ty == "run_finished"
        || ty == "terminal"
        || ty == "run_terminal"
        || ty == "finished"
        || ty == "error"
}

fn is_run_started_unit(unit: &Value) -> bool {
    unit_type(unit)
        .map(str::to_ascii_lowercase)
        .is_some_and(|ty| ty == "run_started" || ty == "runstarted")
}

fn is_step_finished_unit(unit: &Value) -> bool {
    unit_type(unit)
        .map(str::to_ascii_lowercase)
        .is_some_and(|ty| ty == "step_finished" || ty == "stepfinished")
}

/// A length-class finish reason on ANY unit (step or terminal): providers spell it
/// "length", "max_tokens", or "max_output_tokens" depending on the wire family.
fn unit_is_length_capped(unit: &Value) -> bool {
    unit.get("finish_reason")
        .or_else(|| unit.get("finishReason"))
        .and_then(Value::as_str)
        .is_some_and(|reason| {
            let reason = reason.to_ascii_lowercase();
            reason == "length" || reason == "max_tokens" || reason == "max_output_tokens"
        })
}

fn is_paused_unit(unit: &Value) -> bool {
    unit_type(unit)
        .map(str::to_ascii_lowercase)
        .is_some_and(|ty| ty == "paused")
}

fn paused_reason(unit: &Value) -> Option<&str> {
    unit.get("reason")
        .or_else(|| unit.get("detail"))
        .and_then(Value::as_str)
}

fn is_error_unit(unit: &Value) -> bool {
    unit_type(unit)
        .map(str::to_ascii_lowercase)
        .is_some_and(|ty| ty == "error" || ty == "run_error")
}

#[derive(Debug, Default)]
struct UnitErrorInfo {
    detail: Option<String>,
    classification: Option<ErrorClassification>,
    class_field_present: bool,
}

fn unit_error_info(unit: &Value) -> UnitErrorInfo {
    if let Some(error) = unit.get("error") {
        let (classification, class_field_present) = classification_from_object(error);
        let detail = error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| unit.get("detail").and_then(Value::as_str))
            .or_else(|| unit.get("message").and_then(Value::as_str))
            .map(ToString::to_string)
            .or_else(|| error.as_str().map(ToString::to_string))
            .or_else(|| Some(error.to_string()));
        // Keep reset siblings that would otherwise disappear when only message is retained.
        let detail = if provider_retry_at_ms(error, 0, 0).is_some() {
            Some(error.to_string())
        } else {
            detail
        };
        return UnitErrorInfo {
            detail,
            classification,
            class_field_present,
        };
    }

    let detail = unit
        .get("detail")
        .or_else(|| unit.get("message"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let (classification, class_field_present) = detail
        .as_deref()
        .and_then(classification_from_json_text)
        .unwrap_or((None, false));
    UnitErrorInfo {
        detail,
        classification,
        class_field_present,
    }
}

fn consumer_identity_from_launch() -> Option<ConsumerIdentity> {
    let module_id = std::env::var(SUBC_MODULE_ID_ENV).ok()?;
    // Share the SDK's cached HELLO read: the first read consumes and closes the pipe.
    let launch_nonce = subc_client_rs::launch_nonce().ok()??.value().to_owned();
    (!module_id.is_empty() && !launch_nonce.is_empty()).then_some(ConsumerIdentity {
        module_id,
        launch_nonce,
    })
}

fn error_body(body: &[u8]) -> ProducerErrorBody {
    match serde_json::from_slice::<Value>(body) {
        Ok(value) => ProducerErrorBody::from_value(value),
        Err(e) => ProducerErrorBody::untagged("invalid_error_body", e.to_string()),
    }
}

fn retry_delay_seconds(text: &str) -> Option<f64> {
    if let Ok(seconds) = text.parse::<f64>() {
        return Some(seconds);
    }
    let mut total = 0.0;
    let mut start = 0;
    for (index, unit) in text.char_indices() {
        if unit.is_ascii_digit() || unit == '.' {
            continue;
        }
        let scale = match unit {
            'h' => 3600.0,
            'm' => 60.0,
            's' => 1.0,
            _ => return None,
        };
        total += text[start..index].parse::<f64>().ok()? * scale;
        start = index + unit.len_utf8();
    }
    (start == text.len() && start > 0).then_some(total)
}

/// Walk only structured retry fields, including JSON carried inside provider messages.
/// Absolute resets take precedence over relative delays in the same object.
fn provider_retry_at_ms(value: &Value, now_ms: i64, depth: usize) -> Option<i64> {
    if depth > 12 {
        return None;
    }
    match value {
        Value::Object(fields) => {
            let absolute = ["quotaResetTimeStamp", "quotaResetTimestamp", "retry_at"]
                .into_iter()
                .filter_map(|key| fields.get(key).and_then(Value::as_str))
                .filter_map(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
                .map(|time| time.timestamp_millis())
                .min();
            if absolute.is_some() {
                return absolute;
            }
            let relative = ["quotaResetDelay", "retryDelay", "retry_after"]
                .into_iter()
                .filter_map(|key| fields.get(key))
                .filter_map(|value| {
                    let seconds = value
                        .as_f64()
                        .or_else(|| value.as_str().and_then(retry_delay_seconds))?;
                    (seconds.is_finite() && seconds >= 0.0)
                        .then_some(now_ms.saturating_add((seconds * 1000.0).ceil() as i64))
                })
                .min();
            relative.or_else(|| {
                fields
                    .values()
                    .filter_map(|child| provider_retry_at_ms(child, now_ms, depth + 1))
                    .min()
            })
        }
        Value::Array(values) => values
            .iter()
            .filter_map(|child| provider_retry_at_ms(child, now_ms, depth + 1))
            .min(),
        Value::String(text) => serde_json::from_str::<Value>(text)
            .ok()
            .or_else(|| {
                let start = text.find('{')?;
                let end = text.rfind('}')?;
                if end < start {
                    return None;
                }
                serde_json::from_str::<Value>(&text[start..=end]).ok()
            })
            .and_then(|nested| provider_retry_at_ms(&nested, now_ms, depth + 1)),
        _ => None,
    }
}

fn classification_from_json_text(s: &str) -> Option<(Option<ErrorClassification>, bool)> {
    serde_json::from_str::<Value>(s)
        .ok()
        .map(|value| classification_from_object(&value))
}

fn classification_from_object(value: &Value) -> (Option<ErrorClassification>, bool) {
    let Some(class_value) = value.get("class") else {
        return (None, false);
    };
    let Some(class) = class_value.as_str().and_then(ErrorClass::from_wire) else {
        return (None, true);
    };
    (
        Some(ErrorClassification {
            class,
            retry_after_secs: value
                .get("retry_after_secs")
                .and_then(retry_after_secs_from_value),
        }),
        true,
    )
}

fn retry_after_secs_from_value(value: &Value) -> Option<u64> {
    if let Some(secs) = value.as_u64() {
        return Some(secs);
    }
    let secs = value.as_f64()?;
    if secs.is_finite() && secs >= 0.0 {
        Some(secs.ceil() as u64)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, net::SocketAddr, sync::Arc};

    use serde_json::json;
    use subc_transport::{
        authenticate_server, generate_daemon_id, generate_key, write_atomic, ConnectionInfo,
        Endpoint, SCHEMA_VERSION,
    };
    use tempfile::TempDir;
    use tokio::{net::TcpListener, sync::Mutex};

    #[cfg(unix)]
    #[test]
    fn pipe_only_launch_identity_reuses_sdk_nonce() {
        const CHILD: &str = "MC_TEST_PIPE_IDENTITY_CHILD";
        const NONCE: &str = "pipe-only-mc-launch-nonce";
        const TEST: &str = "historian_producer::tests::pipe_only_launch_identity_reuses_sdk_nonce";
        if std::env::var_os(CHILD).is_some() {
            assert!(std::env::var_os(subc_protocol::SUBC_LAUNCH_NONCE_ENV).is_none());
            // HELLO uses this same accessor before the historian opens a route.
            let hello_nonce = subc_client_rs::launch_nonce().unwrap().unwrap();
            assert_eq!(hello_nonce.value(), NONCE);
            assert_eq!(hello_nonce.source().as_str(), "fd");
            let provenance = crate::manifest("magic-context").provenance.unwrap();
            assert_eq!(
                serde_json::to_value(provenance).unwrap()["launch_nonce_source"],
                "fd"
            );
            for _ in 0..2 {
                let identity = consumer_identity_from_launch().expect("pipe-only route identity");
                assert_eq!(identity.module_id, "magic-context");
                assert_eq!(identity.launch_nonce, NONCE);
            }
            return;
        }

        // A fresh process isolates the process-wide nonce cache from other tests.
        let handoff = subc_os::LaunchNonceHandoff::new(NONCE).unwrap();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", TEST, "--nocapture"])
            .env(CHILD, "1")
            .env(SUBC_MODULE_ID_ENV, "magic-context")
            .env_remove(subc_protocol::SUBC_LAUNCH_NONCE_ENV)
            .env(subc_os::LAUNCH_NONCE_FD_ENV, handoff.fd_env_value());
        handoff.install_last(&mut command);
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "pipe-only child failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    }

    #[test]
    fn producer_token_log_distinguishes_missing_usage_from_zero_and_reports_cap() {
        assert_eq!(
            producer_token_log(None, None, false),
            json!({"input":null,"output":null,"reasoning":null,"cache_read":null,"cache_write":null,"max_tokens":null,"finish_reason":null})
        );
        let usage = ProducerUsage::from_runner_usage(&json!({"input_tokens":4,"output_tokens":32,"cached_input_tokens":0,"cache_write_tokens":2})).unwrap();
        assert_eq!(
            producer_token_log(Some(usage), Some(32), true),
            json!({"input":4,"output":32,"reasoning":null,"cache_read":0,"cache_write":2,"max_tokens":32,"finish_reason":"length"})
        );
    }

    #[test]
    fn provider_reset_metadata_survives_open_and_terminal_errors() {
        let reset = chrono::DateTime::parse_from_rfc3339("2026-09-11T20:34:51Z")
            .unwrap()
            .timestamp_millis();
        let value = json!({"code":"429", "message":"quota exhausted", "class":"transient", "metadata":{"quotaResetTimeStamp":"2026-09-11T20:34:51Z", "quotaResetDelay":"1h36m"}});
        let error = HistorianProducerError::Subc(ProducerErrorBody::from_value(value.clone()));
        assert_eq!(error.provider_retry_at_ms(1000), Some(reset));
        let info = unit_error_info(&json!({"error":value}));
        let error = HistorianProducerError::RunFailed {
            run_id: "r".into(),
            detail: info.detail.unwrap(),
            classification: info.classification,
            class_field_present: info.class_field_present,
        };
        assert_eq!(error.provider_retry_at_ms(1000), Some(reset));
        let delay =
            HistorianProducerError::retryable_model_failure(r#"{"quotaResetDelay":"1h36m0.5s"}"#);
        assert_eq!(delay.provider_retry_at_ms(1000), Some(5_761_500));
        let invalid = HistorianProducerError::retryable_model_failure(
            r#"{"quotaResetTimeStamp":"invalid","quotaResetDelay":"-1s"}"#,
        );
        assert_eq!(invalid.provider_retry_at_ms(1000), None);
        let quota =
            HistorianProducerError::Subc(ProducerErrorBody::untagged("429", "QUOTA_EXHAUSTED"));
        assert!(quota.is_retryable_model_failure());
    }

    #[test]
    fn runner_refusal_literals_map_to_the_reporting_stage() {
        assert_eq!(RUNNER_REFUSAL_OPEN_CODES, ["open_failed"]);
        assert_eq!(
            RUNNER_REFUSAL_OPEN_MESSAGE_LITERALS,
            [
                "run resolution failed",
                "no apikey credential for provider",
                "unknown provider",
                "unknown model",
            ]
        );

        let cases = [
            (
                "open failed: run resolution failed: no apikey credential for provider 'google'",
                RunnerRefusalStage::Credential,
            ),
            (
                "open failed: run resolution failed: unknown provider 'missing'",
                RunnerRefusalStage::Provider,
            ),
            (
                "open failed: run resolution failed: unknown model 'missing'",
                RunnerRefusalStage::Model,
            ),
            (
                "open failed: run resolution failed: malformed runner selection",
                RunnerRefusalStage::Resolution,
            ),
        ];
        for (message, expected_stage) in cases {
            let error =
                HistorianProducerError::Subc(ProducerErrorBody::untagged("open_failed", message));
            let refusal = error.runner_refusal().expect("runner refusal");
            assert_eq!(refusal.stage, expected_stage);
            assert_eq!(refusal.received_code, "open_failed");
            assert_eq!(refusal.received_message, message);
        }

        let unmatched = HistorianProducerError::Subc(ProducerErrorBody::untagged(
            "open_failed",
            "open failed: route closed before bind completed",
        ));
        assert_eq!(
            unmatched
                .runner_refusal()
                .expect("unmatched open refusal")
                .stage,
            RunnerRefusalStage::Resolution
        );
        let wrong_outer_code = HistorianProducerError::Subc(ProducerErrorBody::untagged(
            "route_rejected",
            "run resolution failed: unknown provider 'opencode'",
        ));
        assert!(wrong_outer_code.runner_refusal().is_none());
    }

    #[test]
    fn open_failed_detail_class_overrides_message_and_unknown_classes_never_fall_back() {
        for (class, message, durable, retryable) in [
            ("permanent", "runner selection rejected", true, false),
            (
                "transient",
                "run resolution failed: unknown model 'x'",
                false,
                true,
            ),
            (
                "permanent",
                "rate limit; no apikey credential for provider 'x'",
                true,
                false,
            ),
            (
                "future_class",
                "rate limit; unknown provider 'x'",
                false,
                false,
            ),
        ] {
            let parsed = error_body(
                &serde_json::to_vec(&json!({
                    "code": "open_failed",
                    "message": message,
                    "detail": {"class": class, "retry_after_secs": 120}
                }))
                .unwrap(),
            );
            let error = HistorianProducerError::Subc(parsed);
            assert!(error.has_class_field());
            assert_eq!(error.is_retryable_model_failure(), retryable, "{class}");
            assert_eq!(
                error.runner_refusal().unwrap().is_durable(),
                durable,
                "{class}"
            );
            assert_eq!(
                error.classification(),
                ErrorClass::from_wire(class).map(|class| ErrorClassification {
                    class,
                    retry_after_secs: Some(120),
                })
            );
        }
        for detail in [Value::Null, json!({"cause": "catalog"})] {
            let error = HistorianProducerError::Subc(error_body(
                &serde_json::to_vec(&json!({
                    "code": "open_failed",
                    "message": "run resolution failed: unknown model 'x'",
                    "detail": detail
                }))
                .unwrap(),
            ));
            assert!(!error.has_class_field());
            assert!(
                error.runner_refusal().unwrap().is_durable(),
                "legacy stage fallback"
            );
        }
    }

    #[test]
    fn error_class_wire_strings_match_pinned_contract_set() {
        assert_eq!(
            ERROR_CLASS_WIRE_SET,
            [
                "transient",
                "permanent",
                "auth_required",
                "context_overflow"
            ]
        );
        assert_eq!(ErrorClass::Transient.as_wire_str(), "transient");
        assert_eq!(ErrorClass::Permanent.as_wire_str(), "permanent");
        assert_eq!(ErrorClass::AuthRequired.as_wire_str(), "auth_required");
        assert_eq!(
            ErrorClass::ContextOverflow.as_wire_str(),
            "context_overflow"
        );
        assert_eq!(
            ErrorClass::from_wire("auth"),
            Some(ErrorClass::AuthRequired)
        );
    }

    #[test]
    fn parses_tagged_subc_error_body_from_contract_shape() {
        let body = serde_json::to_vec(&json!({
            "code": "provider_error",
            "message": "rate limit window",
            "class": "transient",
            "retry_after_secs": 120,
            "provider_code": "rate_limit_exceeded"
        }))
        .unwrap();

        let parsed = error_body(&body);
        assert_eq!(parsed.code, "provider_error");
        assert_eq!(
            parsed.classification(),
            Some(ErrorClassification {
                class: ErrorClass::Transient,
                retry_after_secs: Some(120),
            })
        );
    }

    #[test]
    fn parses_current_llm_runner_control_error_shape() {
        let unit = json!({
            "type": "error",
            "error": {
                "class": "permanent",
                "message": "model id does not exist",
                "status": 404,
                "provider_code": "model_not_found"
            }
        });

        let info = unit_error_info(&unit);
        assert_eq!(info.detail.as_deref(), Some("model id does not exist"));
        assert_eq!(
            info.classification,
            Some(ErrorClassification {
                class: ErrorClass::Permanent,
                retry_after_secs: None,
            })
        );
    }

    #[test]
    fn send_outcome_reads_the_runner_send_contract() {
        // Both shapes ride a `result` envelope and are tagged by `state`.
        assert_eq!(
            send_outcome(&json!({"result":{"state":"active","run_id":"run-9"}})),
            SendOutcome::Active("run-9".to_string())
        );
        assert_eq!(
            send_outcome(&json!({"result":{"state":"pending","submission_id":"sub-3"}})),
            SendOutcome::Queued("sub-3".to_string()),
            "a queued prompt was ACCEPTED behind a busy session, not malformed"
        );
        // An un-enveloped reply carrying the run directly stays readable.
        assert_eq!(
            send_outcome(&json!({"state":"active","run_id":"run-flat"})),
            SendOutcome::Active("run-flat".to_string())
        );
        // A submission id without the pending state is not a queue acknowledgement.
        assert_eq!(
            send_outcome(&json!({"result":{"submission_id":"sub-4"}})),
            SendOutcome::Unrecognized
        );
        assert_eq!(send_outcome(&json!({})), SendOutcome::Unrecognized);
        assert_eq!(send_outcome(&Value::Null), SendOutcome::Unrecognized);
    }

    #[derive(Debug, Default)]
    struct ServerLog {
        route_sessions: Vec<String>,
        sends: Vec<Value>,
        subscribes: Vec<Value>,
        retracts: Vec<Value>,
        goodbyes: Vec<u16>,
    }

    struct FakeServer {
        connection_file: PathBuf,
        log: Arc<Mutex<ServerLog>>,
        _temp: TempDir,
    }

    async fn fake_server(send_response: Value, stream_events: Vec<Value>) -> FakeServer {
        fake_server_with_lost_send_reply(send_response, stream_events, false).await
    }

    async fn fake_server_with_lost_send_reply(
        send_response: Value,
        stream_events: Vec<Value>,
        mut lose_first_reply: bool,
    ) -> FakeServer {
        let temp = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let key = generate_key().unwrap();
        let daemon_id = generate_daemon_id().unwrap();
        let connection_file = temp.path().join("subc-connection.json");
        write_atomic(
            &connection_file,
            &ConnectionInfo {
                schema: SCHEMA_VERSION,
                wire_version: Some(subc_protocol::PROTOCOL_VERSION),
                endpoints: vec![Endpoint {
                    host: addr.ip().to_string(),
                    port: addr.port(),
                }],
                key: key.clone(),
                daemon_id,
                pid: std::process::id(),
                daemon_ver: "fake".to_string(),
            },
        )
        .unwrap();
        let log = Arc::new(Mutex::new(ServerLog::default()));
        let log_task = Arc::clone(&log);
        tokio::spawn(async move {
            let mut stream_events: VecDeque<Value> = stream_events.into();
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                authenticate_server(
                    &mut stream,
                    &key,
                    &daemon_id,
                    "fake",
                    Duration::from_secs(2),
                )
                .await
                .unwrap();
                let mut next_route = 10u16;
                let mut route_sessions = std::collections::HashMap::<u16, String>::new();
                loop {
                    let Some(frame) = read_frame(&mut stream).await.unwrap() else {
                        break;
                    };
                    match frame.header.ty {
                        FrameType::Goodbye => {
                            log_task.lock().await.goodbyes.push(frame.header.channel);
                        }
                        FrameType::Request if frame.header.channel == 0 => {
                            let req: ClientControlRequest =
                                serde_json::from_slice(&frame.body).unwrap();
                            if let ClientControlRequest::RouteOpen { identity, .. } = req {
                                let route = next_route;
                                next_route += 1;
                                route_sessions.insert(route, identity.session.clone());
                                log_task.lock().await.route_sessions.push(identity.session);
                                send_response_frame(
                                    &mut stream,
                                    frame.header.channel,
                                    frame.header.epoch,
                                    frame.header.corr,
                                    serde_json::to_vec(&ClientControlResponse::RouteOpen {
                                        route_channel: route,
                                        route_epoch: 1,
                                    })
                                    .unwrap(),
                                )
                                .await;
                            }
                        }
                        FrameType::Request => {
                            let req: Value = serde_json::from_slice(&frame.body).unwrap();
                            match req.get("method").and_then(Value::as_str) {
                                Some("session.send") => {
                                    log_task.lock().await.sends.push(req["params"].clone());
                                    if lose_first_reply {
                                        lose_first_reply = false;
                                        continue;
                                    }
                                    send_response_frame(
                                        &mut stream,
                                        frame.header.channel,
                                        frame.header.epoch,
                                        frame.header.corr,
                                        serde_json::to_vec(&send_response).unwrap(),
                                    )
                                    .await;
                                }
                                Some("session.subscribe") => {
                                    log_task.lock().await.subscribes.push(req["params"].clone());
                                    while let Some(event) = stream_events.pop_front() {
                                        send_stream_data(
                                            &mut stream,
                                            frame.header.channel,
                                            frame.header.epoch,
                                            frame.header.corr,
                                            event,
                                        )
                                        .await;
                                    }
                                    send_stream_end(
                                        &mut stream,
                                        frame.header.channel,
                                        frame.header.epoch,
                                        frame.header.corr,
                                    )
                                    .await;
                                }
                                Some("run.status") => {
                                    send_response_frame(
                                    &mut stream,
                                    frame.header.channel,
                                    frame.header.epoch,
                                    frame.header.corr,
                                    serde_json::to_vec(
                                        &json!({"state":"terminal","run_id":"run-1","head":"h"}),
                                    )
                                    .unwrap(),
                                )
                                .await;
                                }
                                Some("run.cancel") => {
                                    send_response_frame(
                                        &mut stream,
                                        frame.header.channel,
                                        frame.header.epoch,
                                        frame.header.corr,
                                        serde_json::to_vec(&json!({"ack":true})).unwrap(),
                                    )
                                    .await;
                                }
                                Some("session.retract") => {
                                    log_task.lock().await.retracts.push(req["params"].clone());
                                    send_response_frame(
                                        &mut stream,
                                        frame.header.channel,
                                        frame.header.epoch,
                                        frame.header.corr,
                                        serde_json::to_vec(&json!({"result":"retracted"})).unwrap(),
                                    )
                                    .await;
                                }
                                other => panic!(
                                    "unexpected request {other:?} on route {:?}",
                                    route_sessions.get(&frame.header.channel)
                                ),
                            }
                        }
                        _ => {}
                    }
                }
            }
        });
        FakeServer {
            connection_file,
            log,
            _temp: temp,
        }
    }

    async fn send_response_frame(
        stream: &mut TcpStream,
        channel: u16,
        epoch: u32,
        corr: u64,
        body: Vec<u8>,
    ) {
        let frame = Frame::build(
            FrameType::Response,
            Flags::new(false, Priority::Interactive, false),
            channel,
            epoch,
            corr,
            body,
        )
        .unwrap();
        write_frame(stream, &frame).await.unwrap();
    }

    async fn send_stream_data(
        stream: &mut TcpStream,
        channel: u16,
        epoch: u32,
        corr: u64,
        event: Value,
    ) {
        let frame = Frame::build(
            FrameType::StreamData,
            Flags::new(false, Priority::Interactive, false),
            channel,
            epoch,
            corr,
            serde_json::to_vec(&event).unwrap(),
        )
        .unwrap();
        write_frame(stream, &frame).await.unwrap();
    }

    async fn send_stream_end(stream: &mut TcpStream, channel: u16, epoch: u32, corr: u64) {
        let frame = Frame::build(
            FrameType::StreamEnd,
            Flags::new(false, Priority::Interactive, false),
            channel,
            epoch,
            corr,
            Vec::new(),
        )
        .unwrap();
        write_frame(stream, &frame).await.unwrap();
    }

    async fn client(server: &FakeServer) -> HistorianProducer {
        HistorianProducer::connect(HistorianProducerConfig {
            connection_file: server.connection_file.clone(),
            project_root: std::env::current_dir().unwrap(),
            harness: "mc-test".to_string(),
            route_targets: RouteTargetConfig::runner_module("llm-runner"),
            handshake_timeout: Duration::from_secs(2),
            request_timeout: Duration::from_secs(2),
            await_timeout: Duration::from_secs(2),
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn lost_send_reply_retry_reuses_attempt_send_id_after_reconnect() {
        let server = fake_server_with_lost_send_reply(
            json!({"state":"active","run_id":"run-1"}),
            Vec::new(),
            true,
        )
        .await;
        let mut first = client(&server).await;
        first.config.request_timeout = Duration::from_millis(50);
        let session = "mc-historian:proj:lineage:1";
        let error = first
            .start(session, "role", "prompt", "prov/model-a")
            .await
            .unwrap_err();
        assert!(matches!(error, HistorianProducerError::TimedOut));
        first.close().await;
        drop(first);

        // A retry of the same logical send survives a fresh connection and corr id.
        let mut retry = client(&server).await;
        let handle = retry
            .start(session, "role", "prompt", "prov/model-a")
            .await
            .unwrap();
        assert_eq!(handle.run_id, "run-1");
        retry.close().await;
        let log = server.log.lock().await;
        assert_eq!(log.sends.len(), 2);
        assert_eq!(log.sends[0]["send_id"], json!(session));
        assert_eq!(log.sends[1]["send_id"], json!(session));
    }

    #[tokio::test]
    async fn new_historian_and_dreamer_attempts_get_distinct_send_ids() {
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), Vec::new()).await;
        let mut client = client(&server).await;
        let sessions = [
            crate::historian::historian_producer_session_id("proj", "lineage", 1),
            crate::historian::historian_producer_session_id("proj", "lineage", 2),
            crate::classify::child_session_id("proj", "command", 1),
            crate::classify::child_session_id("proj", "command", 2),
        ];
        for session in &sessions {
            client
                .start(session, "role", "prompt", "prov/model-a")
                .await
                .unwrap();
            client.close().await;
        }
        let log = server.log.lock().await;
        assert_eq!(log.sends.len(), sessions.len());
        let ids = log
            .sends
            .iter()
            .map(|params| params["send_id"].as_str().expect("send_id on every send"))
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            ids.len(),
            sessions.len(),
            "even identical prompts need a new id for a new attempt"
        );
    }

    #[tokio::test]
    async fn purge_session_reports_retention_and_closes_both_routes() {
        const CHILD: &str = "MC_TEST_RUNNER_RETENTION_CHILD";
        const TEST: &str =
            "historian_producer::tests::purge_session_reports_retention_and_closes_both_routes";
        if std::env::var_os(CHILD).is_none() {
            // Isolate the process-wide once-only warning from parallel tests.
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--nocapture"])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "retention child failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
            return;
        }
        struct LogWriter(Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for LogWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let logs = Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer = Arc::clone(&logs);
        tracing::subscriber::set_global_default(
            tracing_subscriber::fmt()
                .without_time()
                .with_ansi(false)
                .with_writer(move || LogWriter(Arc::clone(&writer)))
                .finish(),
        )
        .unwrap();
        let server = fake_server(json!({}), Vec::new()).await;
        let mut client = client(&server).await;
        client.bind_session("mc-dreamer:classify:snapshot");
        client.ensure_command_route().await.unwrap();
        client.ensure_subscribe_route().await.unwrap();
        let error = crate::historian::HistorianProducerDriver::purge_session(
            &mut client,
            "mc-dreamer:classify:snapshot",
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            HistorianProducerError::RunnerSessionDeletionUnsupported { .. }
        ));
        assert!(error
            .to_string()
            .contains("stays in Broca's store indefinitely"));
        assert!(client.command_route.is_none());
        assert!(client.subscribe_route.is_none());
        client.purge_session("another-snapshot").await.unwrap_err();
        // Goodbye frames reach the fake server asynchronously; a loaded runner can
        // take longer than a fixed sleep, so wait for both with a deadline.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while server.log.lock().await.goodbyes.len() < 2 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let log = server.log.lock().await;
        assert_eq!(log.route_sessions, vec!["mc-dreamer:classify:snapshot"; 2]);
        assert_eq!(log.goodbyes, vec![11, 10]);
        assert!(log.sends.is_empty());
        let logs = String::from_utf8(logs.lock().unwrap().clone()).unwrap();
        assert_eq!(logs.matches("runner cannot delete sessions").count(), 1);
        assert!(logs.contains("memory-pool snapshots"));
        assert!(logs.contains("never deletes a session"));
    }

    #[tokio::test]
    async fn start_binds_session_at_route_open_and_omits_session_param() {
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), Vec::new()).await;
        let mut client = client(&server).await;
        let handle = client
            .start(
                "mc-historian:proj:1",
                "role guidance",
                "prompt",
                "prov/model-a",
            )
            .await
            .unwrap();
        assert_eq!(handle.run_id, "run-1");
        client.close().await;
        tokio::time::sleep(Duration::from_millis(20)).await;

        let log = server.log.lock().await;
        assert_eq!(log.route_sessions, vec!["mc-historian:proj:1"]);
        assert_eq!(log.sends.len(), 1);
        assert!(
            log.sends[0].get("session").is_none(),
            "session id lives in BindIdentity, not params"
        );
        assert_eq!(
            log.sends[0]["model"],
            json!({ "provider": "prov", "model": "model-a" }),
            "model is llm-runner's nested ModelParams object, split at the FIRST slash"
        );
        assert_eq!(log.sends[0]["tools"], json!([]));
        assert_eq!(
            log.sends[0]["generation"]["max_output_tokens"],
            json!(HISTORIAN_MAX_OUTPUT_TOKENS),
            "an explicit output budget rides every send: llm-runner's default truncated a real summarization pass"
        );
        assert!(
            log.sends[0]["generation"].get("temperature").is_none(),
            "an omitted historian temperature must not become a provider instruction"
        );
        assert_eq!(
            log.sends[0]["system"],
            json!("role guidance"),
            "system rides the role-scoped SendParams field, byte-exact"
        );
        assert_eq!(log.goodbyes, vec![10]);
    }

    #[tokio::test]
    async fn a_queued_send_is_named_as_such_and_its_submission_is_withdrawn() {
        let server = fake_server(
            json!({"result":{"state":"pending","submission_id":"sub-77"}}),
            Vec::new(),
        )
        .await;
        let mut client = client(&server).await;
        let error = client
            .start("mc-dreamer:classify:abc", "role", "prompt", "prov/model-a")
            .await
            .expect_err("a queued send starts no run");

        match &error {
            HistorianProducerError::SendQueued {
                submission_id,
                retracted,
            } => {
                assert_eq!(submission_id, "sub-77");
                assert!(retracted, "the queued submission must be withdrawn");
            }
            other => panic!("expected a queued send, got {other:?}"),
        }
        assert!(
            error.to_string().contains("already active on the session"),
            "the message must name the busy session, not a missing field: {error}"
        );
        assert!(
            error.is_retryable_model_failure(),
            "a busy session clears; the caller should try again"
        );
        client.close().await;
        tokio::time::sleep(Duration::from_millis(20)).await;

        let log = server.log.lock().await;
        assert_eq!(log.retracts.len(), 1);
        assert_eq!(log.retracts[0]["submission_id"], json!("sub-77"));
    }

    #[tokio::test]
    async fn start_with_explicit_temperature_serializes_it() {
        for temperature in [0.1, 0.0] {
            let server = fake_server(
                json!({"state":"active","run_id":"run-temperature"}),
                Vec::new(),
            )
            .await;
            let mut client = client(&server).await;
            client
                .start_with_temperature(
                    "mc-historian:proj:1",
                    "role guidance",
                    "prompt",
                    "prov/model-a",
                    None,
                    Some(temperature),
                )
                .await
                .unwrap();
            client.close().await;
            tokio::time::sleep(Duration::from_millis(20)).await;

            let log = server.log.lock().await;
            assert_eq!(
                log.sends[0]["generation"]["temperature"],
                json!(temperature)
            );
        }
    }

    /// Broca's own `session.send` goldens, vendored byte-for-byte; see
    /// `testdata/broca/README.md` for their source path and Broca commit.
    const BROCA_SEND_MODEL_VARIANT_QUEUE: &str =
        include_str!("../testdata/broca/send_request.model_variant_queue.json");
    const BROCA_SEND_MODEL_VARIANT_STEER: &str =
        include_str!("../testdata/broca/send_request.model_variant_steer.json");

    fn golden_send_params(variant: Option<&str>) -> String {
        let request = session_send_request(
            "s-1",
            "",
            "continue",
            "openai/gpt-6.1-sol",
            variant,
            HISTORIAN_MAX_OUTPUT_TOKENS,
            None,
        )
        .unwrap();
        assert_eq!(request.method, "session.send");
        serde_json::to_string(&request.params).unwrap()
    }

    /// The send params this client serializes start with exactly Broca's queued-send
    /// golden (`prompt`, `send_id`, `model` with its variant), byte for byte. Only the
    /// fields Broca's golden leaves out (`tools`, `generation`) follow it.
    #[test]
    fn session_send_with_variant_matches_broca_queue_golden_bytes() {
        let golden_body = BROCA_SEND_MODEL_VARIANT_QUEUE
            .strip_suffix('}')
            .expect("golden is one JSON object");
        assert_eq!(
            golden_send_params(Some("high")),
            format!(
                "{golden_body},\"tools\":[],\"generation\":{{\"max_output_tokens\":{HISTORIAN_MAX_OUTPUT_TOKENS}}}}}"
            )
        );
    }

    /// Broca's steer golden carries the same `model` object plus `delivery: "steer"`.
    /// This client never sends `delivery` (every send is a queued send, which must name
    /// its variant), so the steer golden pins only that the model object is shared.
    #[test]
    fn broca_steer_golden_shares_the_queue_golden_model_object() {
        let steer_body = BROCA_SEND_MODEL_VARIANT_STEER
            .strip_suffix(r#","delivery":"steer"}"#)
            .expect("steer golden ends with its delivery field");
        let queue_body = BROCA_SEND_MODEL_VARIANT_QUEUE
            .strip_suffix('}')
            .expect("golden is one JSON object");
        assert_eq!(steer_body, queue_body);
        assert!(
            golden_send_params(Some("high")).starts_with(steer_body),
            "the steer golden's model object must match this client's bytes too"
        );
    }

    #[test]
    fn session_send_without_variant_omits_the_field() {
        let params = golden_send_params(None);
        assert!(
            params.contains(r#","model":{"provider":"openai","model":"gpt-6.1-sol"},"#),
            "{params}"
        );
        assert!(!params.contains("variant"), "{params}");
        // An empty configured variant is absent, never sent as "".
        assert_eq!(golden_send_params(Some("")), params);
    }

    #[tokio::test]
    async fn start_with_generation_sends_the_variant_on_the_wire() {
        let server = fake_server(json!({"state":"active","run_id":"run-v"}), Vec::new()).await;
        let mut client = client(&server).await;
        client
            .start_with_generation(
                "mc-dreamer:classify:v",
                "role",
                "prompt",
                "openai/gpt-6.1-sol",
                Some("high"),
                4_000,
                Some(0.1),
            )
            .await
            .unwrap();
        client.close().await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        let log = server.log.lock().await;
        assert_eq!(
            log.sends[0]["model"],
            json!({ "provider": "openai", "model": "gpt-6.1-sol", "variant": "high" })
        );
        assert_eq!(log.sends[0]["send_id"], json!("mc-dreamer:classify:v"));
        assert_eq!(
            log.sends[0]["generation"]["max_output_tokens"],
            json!(4_000)
        );
        assert_eq!(log.sends[0]["system"], json!("role"));
    }

    #[tokio::test]
    async fn start_omits_system_param_when_empty() {
        // Empty means absent on the wire (the field's empty-as-absent rule); omitting it
        // entirely keeps the send byte-shape identical to pre-system clients.
        let server = fake_server(json!({"state":"active","run_id":"run-9"}), Vec::new()).await;
        let mut client = client(&server).await;
        client
            .start("mc-historian:proj:9", "", "prompt", "prov/model-a")
            .await
            .unwrap();
        client.close().await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        let log = server.log.lock().await;
        assert_eq!(log.sends.len(), 1);
        assert!(
            log.sends[0].get("system").is_none(),
            "empty system must be omitted, not sent as \"\""
        );
    }

    #[test]
    fn unit_text_collects_only_assistant_message_units() {
        let leaked = json!({
            "type": "example_replay",
            "message": {"content": [{"type": "text", "text": "seed output"}]},
            "text": "flat seed output"
        });
        let assistant = json!({
            "type": "assistant_message",
            "message": {"content": [{"type": "text", "text": "real output"}]}
        });

        assert_eq!(unit_text(&leaked), None);
        assert_eq!(unit_text(&assistant).as_deref(), Some("real output"));
    }

    #[tokio::test]
    async fn await_output_uses_control_terminal_not_stream_end() {
        let terminal_text = r#"<output><compartments><compartment start="1" end="1" title="t"><p1>x</p1></compartment></compartments><meta><messages_processed>1-1</messages_processed></meta></output>"#;
        let events = vec![
            json!({"kind":"display","event":{"type":"text_delta","text":"ignored"}}),
            json!({"kind":"control","unit":{"type":"run_started","run_id":"run-1"}}),
            json!({"kind":"control","unit":{"type":"assistant_message","message":{"message_id":"m-1","content":[
                {"type":"reasoning","text":"planning prose that restates start=\"FIRST\" and walks the seed examples"},
                {"type":"text","text":terminal_text}
            ]}}}),
            json!({"kind":"control","unit":{"type":"run_finished","finish_reason":"completed"}}),
        ];
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), events).await;
        let mut client = client(&server).await;
        client
            .start("mc-historian:proj:2", "", "prompt", "prov/model-a")
            .await
            .unwrap();
        let output = client.await_output("run-1").await.unwrap();
        client.close().await;
        // Route release is asynchronous after close(); poll for both goodbyes
        // instead of budgeting a fixed sleep, which raced the second release on
        // slower hardware (issue #373: ~40-60ms observed against a 20ms budget).
        let release_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if server.log.lock().await.goodbyes.len() >= 2 {
                break;
            }
            if tokio::time::Instant::now() >= release_deadline {
                break; // fall through to the assertions for a full diagnostic
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        assert_eq!(output.text, terminal_text);
        let log = server.log.lock().await;
        assert_eq!(
            log.route_sessions,
            vec!["mc-historian:proj:2", "mc-historian:proj:2"]
        );
        assert_eq!(log.subscribes, vec![json!({"from":"start"})]);
        assert_eq!(
            log.goodbyes,
            vec![11, 10],
            "close releases subscribe and command routes"
        );
    }

    /// Run spend is the sum of every step's usage (each step is billed separately); the
    /// terminal's own usage is used only when no step reported any.
    #[tokio::test]
    async fn await_output_sums_step_usage_and_falls_back_to_terminal_usage() {
        let with_steps = vec![
            json!({"kind":"control","unit":{"type":"run_started","run_id":"run-1"}}),
            json!({"kind":"control","unit":{"type":"step_finished","step_id":"s1","finish_reason":"tool_calls",
                "usage":{"input_tokens":10_000,"output_tokens":2_000,"cached_input_tokens":7,"cache_write_tokens":1}}}),
            json!({"kind":"control","unit":{"type":"step_finished","step_id":"s2","finish_reason":"stop",
                "usage":{"input_tokens":4_039,"output_tokens":4_125,"cached_input_tokens":5}}}),
            json!({"kind":"control","unit":{"type":"run_finished","reason":"completed",
                "usage":{"input_tokens":1,"output_tokens":1}}}),
        ];
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), with_steps).await;
        let mut first = client(&server).await;
        first
            .start("mc-historian:proj:4", "", "prompt", "prov/model-a")
            .await
            .unwrap();
        let output = first.await_output("run-1").await.unwrap();
        first.close().await;
        assert_eq!(
            output.usage,
            Some(ProducerUsage {
                input: 14_039,
                output: 6_125,
                cache_read: 12,
                cache_write: 1,
            })
        );

        let terminal_only = vec![
            json!({"kind":"control","unit":{"type":"run_started","run_id":"run-1"}}),
            json!({"kind":"control","unit":{"type":"run_finished","reason":"completed",
                "usage":{"input_tokens":30,"output_tokens":40}}}),
        ];
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), terminal_only).await;
        let mut second = client(&server).await;
        second
            .start("mc-historian:proj:5", "", "prompt", "prov/model-a")
            .await
            .unwrap();
        let output = second.await_output("run-1").await.unwrap();
        second.close().await;
        assert_eq!(
            output.usage,
            Some(ProducerUsage {
                input: 30,
                output: 40,
                cache_read: 0,
                cache_write: 0,
            })
        );
    }

    #[tokio::test]
    async fn terminal_without_matching_run_started_fails_loud() {
        let events = vec![
            json!({"kind":"control","unit":{"type":"run_started","run_id":"other-run"}}),
            json!({"kind":"control","unit":{"type":"run_finished","finish_reason":"completed"}}),
        ];
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), events).await;
        let mut client = client(&server).await;
        client
            .start("mc-historian:proj:3", "", "prompt", "prov/model-a")
            .await
            .unwrap();

        let err = client.await_output("run-1").await.unwrap_err();
        assert!(matches!(
            err,
            HistorianProducerError::TerminalRunMismatch {
                expected,
                found: Some(found),
            } if expected == "run-1" && found == "other-run"
        ));
    }

    #[tokio::test]
    async fn paused_unit_returns_run_paused() {
        let events = vec![
            json!({"kind":"control","unit":{"type":"run_started","run_id":"run-1"}}),
            json!({"kind":"control","unit":{"type":"paused","run_id":"run-1","reason":"auth_required"}}),
        ];
        let server = fake_server(json!({"state":"active","run_id":"run-1"}), events).await;
        let mut client = client(&server).await;
        client
            .start("mc-historian:proj:4", "", "prompt", "prov/model-a")
            .await
            .unwrap();

        let err = client.await_output("run-1").await.unwrap_err();
        assert!(matches!(
            err,
            HistorianProducerError::RunPaused {
                run_id,
                reason: Some(reason),
                ..
            } if run_id == "run-1" && reason == "auth_required"
        ));
    }
}
