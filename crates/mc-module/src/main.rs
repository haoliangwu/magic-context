//! mc-module entrypoint: boot on `subc-client-rs`'s `serve` (provider role).
//!
//! `serve` owns the handshake (read `--subc <connection-file>`, authenticate, send
//! HELLO{manifest}, await HELLO_ACK, then dispatch route data requests to the
//! handler). The handler opens the single-writer store in `on_hello_ack`.

#![forbid(unsafe_code)]

use std::error::Error;
use std::path::PathBuf;

use mc_module::route_targets::RouteTargetConfig;
use mc_module::{manifest_with_route_targets, McHandler, McTransportHandler, DEFAULT_MODULE_ID};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    // Consume the inherited pipe before initialization can start any helper;
    // the SDK's HELLO and historian route opens reuse this process-wide cache.
    subc_os::launch_nonce()?;
    // Fleet convention: a side-effect-free single-line --version, evaluated before
    // any runtime argument so supervisors and test substrates can probe the binary
    // without a connection file.
    if std::env::args().skip(1).any(|arg| arg == "--version") {
        println!("{}", mc_module::version_line());
        return Ok(());
    }
    if std::env::args().skip(1).any(|arg| arg == "--print-fences") {
        println!("{}", mc_module::supported_fences_line());
        return Ok(());
    }
    let enforce_private_permissions = mc_module::config::private_storage_permissions_enabled();
    #[cfg(unix)]
    if enforce_private_permissions {
        // ck-mc owns its process, so a restrictive mask also protects files the
        // external logger and SQLite create without exposing a mode option.
        nix::sys::stat::umask(nix::sys::stat::Mode::from_bits_truncate(0o077));
    }
    // The offline single-store migration runs without subc and without serving: the doctor
    // command calls it while nothing has either database open.
    if std::env::args().nth(1).as_deref() == Some("single-store-migrate") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(mc_module::single_store_migrate::cli_main(&args));
    }
    // The history repair after a migration is also a one-shot command without subc.
    if std::env::args().nth(1).as_deref() == Some("single-store-repair-history") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(mc_module::single_store_repair::cli_main(&args));
    }
    let module_id = std::env::var(subc_protocol::SUBC_MODULE_ID_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODULE_ID.to_string());

    let logger = match cortexkit_log::init_from_env() {
        Ok(logger) => logger,
        Err(cortexkit_log::InitError::ModuleIdNotInEnvironment) => {
            let logger = cortexkit_log::init(cortexkit_log::Config::for_module(DEFAULT_MODULE_ID))?;
            tracing::info!("SUBC_MODULE_ID absent; using magic-context for local module logging");
            logger
        }
        Err(error) => return Err(error.into()),
    };
    tracing::info!("mc-module: logger initialized");
    let log_permissions =
        mc_store::private_permissions::tighten_tree(logger.logs_dir(), enforce_private_permissions);
    tracing::info!(
        tightened = log_permissions.tightened,
        failures = log_permissions.failures,
        "mc-module: log permission tightening"
    );
    let connection_file = parse_subc_arg(std::env::args_os().skip(1))?;
    // The runner settings are user-tier only, so one resolution covers every project
    // this process serves. The manifest's background-completion routes and
    // self-signals follow it: when every role is configured to the host runner, no
    // background-completion route to Broca is opened. An unconfigured role is decided
    // per request by the harness, and a Claude Code request then still goes to Broca,
    // so that route stays declared. The provider runner route (Broca serving as the
    // runner of compaction and step-transform providers) is declared separately and
    // is optional: ck-mc starts and serves without it.
    let route_targets =
        RouteTargetConfig::for_configured_runners(mc_module::config::user_configured_runners());
    subc_client_rs::serve_with(
        &connection_file,
        manifest_with_route_targets(&module_id, &route_targets),
        McTransportHandler::new(
            McHandler::new_with_connection_file_and_route_targets(
                Some(connection_file.clone()),
                route_targets,
            )
            .with_log_directory(logger.logs_dir().to_path_buf()),
        ),
    )
    .await?;
    Ok(())
}

fn parse_subc_arg<I>(mut args: I) -> Result<PathBuf, Box<dyn Error + Send + Sync>>
where
    I: Iterator<Item = std::ffi::OsString>,
{
    while let Some(arg) = args.next() {
        if arg == "--subc" {
            return args
                .next()
                .map(PathBuf::from)
                .ok_or_else(|| "--subc requires a connection-file path".into());
        }
    }
    Err("missing --subc <connection-file>".into())
}
