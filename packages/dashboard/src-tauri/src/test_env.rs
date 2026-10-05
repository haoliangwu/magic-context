use std::ffi::{OsStr, OsString};
use std::sync::{Mutex, MutexGuard};

static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Serialize environment changes and restore each original value even on panic.
pub struct EnvGuard {
    _lock: MutexGuard<'static, ()>,
    previous: Vec<(String, Option<OsString>)>,
}

impl Default for EnvGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl EnvGuard {
    pub fn new() -> Self {
        Self {
            _lock: ENV_LOCK.lock().unwrap_or_else(|poison| poison.into_inner()),
            previous: Vec::new(),
        }
    }

    fn remember(&mut self, key: &str) {
        if !self.previous.iter().any(|(name, _)| name == key) {
            self.previous.push((key.to_string(), std::env::var_os(key)));
        }
    }

    pub fn set(&mut self, key: &str, value: impl AsRef<OsStr>) {
        self.remember(key);
        std::env::set_var(key, value);
    }

    pub fn remove(&mut self, key: &str) {
        self.remember(key);
        std::env::remove_var(key);
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in self.previous.drain(..).rev() {
            if let Some(value) = value {
                std::env::set_var(key, value);
            } else {
                std::env::remove_var(key);
            }
        }
    }
}
