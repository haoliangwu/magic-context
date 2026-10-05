//! Convert raw local token counts using fixed class ratios without changing the
//! tokenizer or persisted counts. Session usage samples do not affect these helpers.

use mc_store::FrozenDecisionCalibration;

pub const CALIBRATION_TABLE_REVISION: &str = "2026-09-30-sol-tokenizer-seeds-v3";

/// Class ratios resolved for a model by the caller.
#[derive(Debug, Clone, Copy)]
pub struct DecisionCalibration {
    pub system_ratio: f64,
    pub tools_ratio: f64,
    pub prose_ratio: f64,
    /// Family-inherited measurements are seeded; only genuinely unknown models are not.
    pub seeded: bool,
    /// Fallback for unknown models: callers must supply at least the largest measured
    /// class ratio in the static table. Values below two are rejected.
    pub unknown_fit_ratio: f64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct LocalMass {
    pub system: f64,
    pub tools: f64,
    pub prose: f64,
}

impl DecisionCalibration {
    pub fn neutral() -> Self {
        Self {
            system_ratio: 1.0,
            tools_ratio: 1.0,
            prose_ratio: 1.0,
            seeded: false,
            unknown_fit_ratio: seeds()
                .iter()
                .flat_map(|seed| [seed.system_ratio, seed.tools_ratio, seed.prose_ratio])
                .fold(2.0, f64::max),
        }
    }

    pub fn from_frozen(frozen: &FrozenDecisionCalibration) -> Option<Self> {
        let ratios = [frozen.system_ratio, frozen.tools_ratio, frozen.prose_ratio];
        if frozen.revision.is_empty()
            || frozen.provider_id.is_empty()
            || frozen.model_id.is_empty()
            || ratios
                .into_iter()
                .any(|ratio| !ratio.is_finite() || ratio <= 0.0)
            || !matches!(
                frozen.source.as_str(),
                "seed" | "family-fallback" | "model-id"
            )
        {
            return None;
        }
        Some(Self {
            system_ratio: frozen.system_ratio,
            tools_ratio: frozen.tools_ratio,
            prose_ratio: frozen.prose_ratio,
            seeded: matches!(frozen.source.as_str(), "family-fallback" | "model-id")
                || ratios.into_iter().any(|ratio| ratio != 1.0),
            unknown_fit_ratio: seeds()
                .iter()
                .flat_map(|seed| [seed.system_ratio, seed.tools_ratio, seed.prose_ratio])
                .fold(2.0, f64::max),
        })
    }

    pub fn freeze_for_model(model_key: Option<&str>) -> FrozenDecisionCalibration {
        let key = model_key.unwrap_or("").to_lowercase();
        let (provider_id, model_id) = key
            .split_once('/')
            .map_or(("unknown", "unknown"), |(provider, model)| {
                (provider, model)
            });
        let calibration = Self::for_model(model_key);
        FrozenDecisionCalibration {
            revision: CALIBRATION_TABLE_REVISION.to_string(),
            provider_id: provider_id.to_string(),
            model_id: model_id.to_string(),
            system_ratio: calibration.system_ratio,
            tools_ratio: calibration.tools_ratio,
            prose_ratio: calibration.prose_ratio,
            source: seed_source(model_key).to_string(),
        }
    }

    /// Accumulate fractional provider mass, then ceil once at the decision boundary.
    /// Invalid inputs yield infinity, so a finite provider window cannot admit them.
    pub fn provider_mass(self, raw: LocalMass, fit: bool) -> f64 {
        if [raw.system, raw.tools, raw.prose]
            .into_iter()
            .any(|count| !count.is_finite() || count < 0.0)
            || [self.system_ratio, self.tools_ratio, self.prose_ratio]
                .into_iter()
                .any(|ratio| !ratio.is_finite() || ratio <= 0.0)
            || (fit
                && !self.seeded
                && (!self.unknown_fit_ratio.is_finite() || self.unknown_fit_ratio < 2.0))
        {
            return f64::INFINITY;
        }
        let total = if fit && !self.seeded {
            (raw.system + raw.tools + raw.prose) * self.unknown_fit_ratio
        } else {
            raw.system * self.system_ratio
                + raw.tools * self.tools_ratio
                + raw.prose * self.prose_ratio
        };
        if total.is_finite() {
            total.ceil()
        } else {
            f64::INFINITY
        }
    }
}

/// Round available real-token budgets down before comparison with raw local mass.
pub fn local_budget(provider_tokens: f64, ratio: f64) -> f64 {
    if !provider_tokens.is_finite() || provider_tokens <= 0.0 || !ratio.is_finite() || ratio <= 0.0
    {
        return 0.0;
    }
    (provider_tokens / ratio).floor()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedEntry {
    prefix: String,
    system_ratio: f64,
    tools_ratio: f64,
    #[serde(default = "neutral_ratio")]
    prose_ratio: f64,
}
fn neutral_ratio() -> f64 {
    1.0
}

fn seeds() -> &'static [SeedEntry] {
    static SEEDS: std::sync::OnceLock<Vec<SeedEntry>> = std::sync::OnceLock::new();
    SEEDS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../packages/plugin/src/hooks/magic-context/tokenizer-calibration-seeds.json"
        ))
        .expect("compiled static calibration table")
    })
}

fn lineage(model: &str) -> Option<(String, Vec<u64>, String)> {
    let tokens: Vec<_> = model.split('-').collect();
    let numeric = |token: &str| {
        !token.is_empty()
            && token
                .split('.')
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    };
    let at = tokens.iter().position(|token| numeric(token))?;
    if at == 0 {
        return None;
    }
    let mut end = at;
    let mut version = Vec::new();
    while end < tokens.len() && numeric(tokens[end]) {
        for part in tokens[end].split('.') {
            version.push(part.parse().ok()?);
        }
        end += 1;
    }
    Some((tokens[..at].join("-"), version, tokens[end..].join("-")))
}
fn version_order(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    for i in 0..a.len().max(b.len()) {
        let order = a.get(i).unwrap_or(&0).cmp(b.get(i).unwrap_or(&0));
        if order != std::cmp::Ordering::Equal {
            return order;
        }
    }
    std::cmp::Ordering::Equal
}

fn canonical_provider(model: &str) -> &'static str {
    if model.starts_with("claude-") {
        "anthropic"
    } else if model.starts_with("gpt-") {
        "openai"
    } else if model.starts_with("gemini-") {
        "google"
    } else {
        ""
    }
}

fn family_seed(provider: &str, model: &str) -> Option<&'static SeedEntry> {
    let (family, version, variant) = lineage(model)?;
    let mut below: Option<(&SeedEntry, Vec<u64>)> = None;
    let mut above: Option<(&SeedEntry, Vec<u64>)> = None;
    for entry in seeds() {
        let Some(seed_model) = entry.prefix.strip_prefix(&format!("{provider}/")) else {
            continue;
        };
        let Some((f, v, kind)) = lineage(seed_model) else {
            continue;
        };
        if f != family || kind != variant {
            continue;
        }
        match version_order(&v, &version) {
            std::cmp::Ordering::Less
                if below
                    .as_ref()
                    .is_none_or(|(_, old)| version_order(&v, old).is_gt()) =>
            {
                below = Some((entry, v))
            }
            std::cmp::Ordering::Greater
                if above
                    .as_ref()
                    .is_none_or(|(_, old)| version_order(&v, old).is_lt()) =>
            {
                above = Some((entry, v))
            }
            _ => {}
        }
    }
    let original = below.or(above);
    if original.as_ref().is_some_and(|(_, v)| v[0] != version[0])
        && !canonical_provider(model).is_empty()
    {
        // Same-generation measurements avoid inheriting a previous tokenizer generation.
        let mut sibling: Option<(&SeedEntry, Vec<u64>)> = None;
        for entry in seeds() {
            let Some(seed_model) = entry.prefix.strip_prefix(&format!("{provider}/")) else {
                continue;
            };
            let Some((f, v, kind)) = lineage(seed_model) else {
                continue;
            };
            if v[0] != version[0]
                || kind != variant
                || f.split('-').next() != family.split('-').next()
            {
                continue;
            }
            let replace = sibling.as_ref().is_none_or(|(_, old)| {
                (version_order(&v, &version).is_le() && version_order(old, &version).is_gt())
                    || (version_order(&v, &version).is_le() && version_order(&v, old).is_gt())
                    || (version_order(old, &version).is_gt() && version_order(&v, old).is_lt())
            });
            if replace {
                sibling = Some((entry, v));
            }
        }
        return sibling.or(original).map(|(entry, _)| entry);
    }
    original.map(|(entry, _)| entry)
}

fn selected_seed(key: &str) -> (Option<&'static SeedEntry>, &'static str) {
    let table = seeds();
    let direct = table
        .iter()
        .filter(|entry| key.starts_with(&entry.prefix))
        .max_by_key(|entry| entry.prefix.len());
    if let Some(seed) = direct {
        return (Some(seed), "seed");
    }
    let Some((provider, model)) = key.split_once('/') else {
        return (None, "seed");
    };
    if table
        .iter()
        .any(|entry| entry.prefix.starts_with(&format!("{provider}/")))
    {
        let inherited = family_seed(provider, model);
        return (
            inherited,
            if inherited.is_some() {
                "family-fallback"
            } else {
                "seed"
            },
        );
    }
    // Providers without measurements can reuse a model measurement; prefer its
    // canonical provider over a relay when model prefixes have equal length.
    let canonical = canonical_provider(model);
    let mut direct_model: Option<&SeedEntry> = None;
    for entry in table {
        let Some((_, seed_model)) = entry.prefix.split_once('/') else {
            continue;
        };
        if !model.starts_with(seed_model) {
            continue;
        }
        let previous_len =
            direct_model.map_or(0, |seed| seed.prefix.split_once('/').unwrap().1.len());
        if seed_model.len() > previous_len
            || (seed_model.len() == previous_len
                && entry.prefix.starts_with(&format!("{canonical}/"))
                && !direct_model
                    .is_some_and(|seed| seed.prefix.starts_with(&format!("{canonical}/"))))
        {
            direct_model = Some(entry);
        }
    }
    let selected = direct_model.or_else(|| {
        if canonical.is_empty() {
            None
        } else {
            family_seed(canonical, model)
        }
    });
    (
        selected,
        if selected.is_some() {
            "model-id"
        } else {
            "seed"
        },
    )
}

/// Report whether the measurement was direct, inherited, or matched by model id.
pub fn seed_source(model_key: Option<&str>) -> &'static str {
    selected_seed(&model_key.unwrap_or("").to_lowercase()).1
}

impl DecisionCalibration {
    /// Match provider prefixes first, then inherited family or same-generation
    /// sibling seeds. Providers without seeds can match the model id alone.
    pub fn for_model(model_key: Option<&str>) -> Self {
        let key = model_key.unwrap_or("").to_lowercase();
        let table = seeds();
        let selected = selected_seed(&key).0;
        Self {
            system_ratio: selected.map_or(1.0, |s| s.system_ratio),
            tools_ratio: selected.map_or(1.0, |s| s.tools_ratio),
            prose_ratio: selected.map_or(1.0, |s| s.prose_ratio),
            seeded: selected.is_some(),
            unknown_fit_ratio: table
                .iter()
                .flat_map(|s| [s.system_ratio, s.tools_ratio, s.prose_ratio])
                .fold(2.0, f64::max),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        system_ratio: f64,
        tools_ratio: f64,
        prose_ratio: f64,
        raw_system: f64,
        raw_tools: f64,
        raw_prose: f64,
        provider_mass: f64,
        provider_budget: f64,
        local_budget: f64,
    }

    #[derive(Deserialize)]
    struct ResolverCase {
        provider: String,
        model: String,
        prefix: Option<String>,
        source: String,
    }

    #[test]
    fn resolves_shared_model_and_provider_cases() {
        let cases: Vec<ResolverCase> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/calibration-resolver.json"
        ))
        .unwrap();
        for case in cases {
            let key = format!("{}/{}", case.provider, case.model);
            let result = DecisionCalibration::for_model(Some(&key));
            let expected = case
                .prefix
                .as_ref()
                .map(|prefix| seeds().iter().find(|seed| &seed.prefix == prefix).unwrap());
            assert_eq!(
                result.system_ratio,
                expected.map_or(1.0, |s| s.system_ratio),
                "{key}"
            );
            assert_eq!(
                result.tools_ratio,
                expected.map_or(1.0, |s| s.tools_ratio),
                "{key}"
            );
            assert_eq!(
                result.prose_ratio,
                expected.map_or(1.0, |s| s.prose_ratio),
                "{key}"
            );
            assert_eq!(result.seeded, expected.is_some(), "{key}");
            assert_eq!(seed_source(Some(&key)), case.source, "{key}");
            let frozen = DecisionCalibration::freeze_for_model(Some(&key));
            assert_eq!(frozen.source, case.source, "{key}");
            let thawed = DecisionCalibration::from_frozen(&frozen).unwrap();
            assert_eq!(thawed.system_ratio, result.system_ratio, "{key}");
            assert_eq!(thawed.seeded, result.seeded, "{key}");
        }
    }

    #[test]
    fn sol_seeds_price_reported_prompt_without_unknown_fit_inflation() {
        for key in ["openai/gpt-6-sol", "openai/gpt-6.1-sol"] {
            let seed = DecisionCalibration::for_model(Some(key));
            assert!(seed.seeded, "{key}");
            assert_eq!(seed_source(Some(key)), "seed", "{key}");
            assert_eq!(
                seed.provider_mass(
                    LocalMass {
                        system: 8000.0,
                        tools: 0.0,
                        prose: 192000.0
                    },
                    true
                ),
                200006.0,
                "{key}"
            );
        }
        let unknown = DecisionCalibration::for_model(Some("openai/gpt-6-madeup"));
        assert!(!unknown.seeded);
        assert_eq!(
            unknown.provider_mass(
                LocalMass {
                    system: 8000.0,
                    tools: 0.0,
                    prose: 192000.0
                },
                true
            ),
            400000.0
        );
    }

    #[test]
    fn shares_independent_fable_arithmetic_with_typescript() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../tests/fixtures/decision-calibration.json"
        ))
        .unwrap();
        let seed = DecisionCalibration {
            system_ratio: fixture.system_ratio,
            tools_ratio: fixture.tools_ratio,
            prose_ratio: fixture.prose_ratio,
            seeded: true,
            unknown_fit_ratio: 2.0,
        };
        assert_eq!(
            seed.provider_mass(
                LocalMass {
                    system: fixture.raw_system,
                    tools: fixture.raw_tools,
                    prose: fixture.raw_prose,
                },
                true
            ),
            fixture.provider_mass
        );
        assert_eq!(
            local_budget(fixture.provider_budget, seed.prose_ratio),
            fixture.local_budget
        );
    }

    #[test]
    fn frozen_revision_survives_restart_and_changes_only_at_the_next_bust() {
        let frozen = FrozenDecisionCalibration {
            revision: "frozen-family-v1".to_string(),
            provider_id: "anthropic".to_string(),
            model_id: "claude-fable-5-1".to_string(),
            system_ratio: 1.511497,
            tools_ratio: 1.551639,
            prose_ratio: 1.571778,
            source: "seed".to_string(),
        };
        let mut meta = mc_store::ModuleMeta {
            decision_calibration: Some(frozen.clone()),
            ..Default::default()
        };
        let restarted: mc_store::ModuleMeta =
            serde_json::from_str(&serde_json::to_string(&meta).unwrap()).unwrap();
        let defer =
            DecisionCalibration::from_frozen(restarted.decision_calibration.as_ref().unwrap())
                .unwrap();
        assert_eq!(defer.tools_ratio, 1.551639);
        assert_eq!(
            restarted.decision_calibration.unwrap().revision,
            "frozen-family-v1"
        );

        let adopted = DecisionCalibration::freeze_for_model(Some("unknown/new-model"));
        meta.decision_calibration = Some(adopted.clone());
        assert_eq!(adopted.revision, CALIBRATION_TABLE_REVISION);
        assert_eq!(
            DecisionCalibration::from_frozen(&adopted)
                .unwrap()
                .tools_ratio,
            1.0
        );
    }

    #[test]
    fn unknown_fit_is_conservative_while_decisions_stay_neutral() {
        let seed = DecisionCalibration {
            system_ratio: 1.0,
            tools_ratio: 1.0,
            prose_ratio: 1.0,
            seeded: false,
            unknown_fit_ratio: 2.0,
        };
        let raw = LocalMass {
            prose: 1000.0,
            ..Default::default()
        };
        assert_eq!(seed.provider_mass(raw, false), 1000.0);
        assert_eq!(seed.provider_mass(raw, true), 2000.0);
        assert_eq!(
            seed.provider_mass(
                LocalMass {
                    prose: f64::NAN,
                    ..raw
                },
                true
            ),
            f64::INFINITY
        );
        assert_eq!(local_budget(100.0, 0.0), 0.0);
    }
}
