//! Minimal JSONC helpers for the dashboard's config inspection.
//!
//! The dashboard reads user/project `magic-context.jsonc` files to detect
//! structure (e.g. whether a project declares a per-project `dreamer` override).
//! These mirror the frontend's conservative JSONC normalizer — they are used to
//! INSPECT config, never to round-trip user content (the plugin's loader is
//! authoritative).

use std::path::Path;

/// Strip JSONC line/block comments AND trailing commas, respecting string
/// literals, so the result parses as plain JSON.
///
/// Single pass over `char`s (NOT bytes): iterating bytes and casting
/// `byte as char` corrupts any multi-byte UTF-8 (non-ASCII paths, CJK, accents)
/// by splitting each code point into Latin-1 bytes. The trailing-comma removal
/// is folded INTO the same string-state-aware loop so a comma inside a string
/// value (e.g. `"a,}b"`) is never mistaken for a trailing `,}` / `,]` and
/// stripped — the previous second-pass operated on the comment-stripped output
/// without string awareness and corrupted such values.
pub fn strip_jsonc(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }
        let next = if i + 1 < chars.len() {
            chars[i + 1]
        } else {
            '\0'
        };
        if c == '/' && next == '/' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && next == '*' {
            i += 2;
            while i + 1 < chars.len() {
                if chars[i] == '*' && chars[i + 1] == '/' {
                    break;
                }
                i += 1;
            }
            i += 2;
            continue;
        }
        // Trailing comma (outside strings only): a `,` whose next char, past any
        // whitespace and comments, is `}` or `]`. Skip emitting it. Comments
        // must be skipped here too: `"a": 1, // note` before `}` is a trailing
        // comma, and keeping it makes the whole file unparseable.
        if c == ',' {
            let k = skip_whitespace_and_comments(&chars, i + 1);
            if k < chars.len() && (chars[k] == '}' || chars[k] == ']') {
                i += 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Index of the first char at or after `start` that is neither whitespace nor
/// part of a `//` or `/* */` comment. Only called outside string literals.
fn skip_whitespace_and_comments(chars: &[char], start: usize) -> usize {
    let mut k = start;
    loop {
        while k < chars.len() && chars[k].is_whitespace() {
            k += 1;
        }
        if k + 1 < chars.len() && chars[k] == '/' && chars[k + 1] == '/' {
            while k < chars.len() && chars[k] != '\n' {
                k += 1;
            }
            continue;
        }
        if k + 1 < chars.len() && chars[k] == '/' && chars[k + 1] == '*' {
            k += 2;
            while k + 1 < chars.len() && !(chars[k] == '*' && chars[k + 1] == '/') {
                k += 1;
            }
            k = (k + 2).min(chars.len());
            continue;
        }
        return k;
    }
}

/// True when the config file at `path` exists AND declares a non-empty `dreamer`
/// object — i.e. this project carries a per-project dreamer override rather than
/// inheriting the global config. Any read/parse failure → false (inherited).
pub fn config_has_dreamer_block(path: &Path) -> bool {
    let raw = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return false,
    };
    let value: serde_json::Value = match serde_json::from_str(&strip_jsonc(&raw)) {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    value
        .get("dreamer")
        .and_then(|d| d.as_object())
        .map(|obj| !obj.is_empty())
        .unwrap_or(false)
}

/// Parse a config file's `dreamer.tasks` into a task→schedule map. Any read or
/// parse failure, or a missing block, yields an empty map (caller falls back to
/// global/default schedules). Used to compute the EFFECTIVE configured schedule
/// for a project rather than its (possibly stale) scheduler snapshot.
pub fn read_dreamer_task_schedules(path: &Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let raw = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return map,
    };
    let value: serde_json::Value = match serde_json::from_str(&strip_jsonc(&raw)) {
        Ok(parsed) => parsed,
        Err(_) => return map,
    };
    if let Some(tasks) = value
        .get("dreamer")
        .and_then(|d| d.get("tasks"))
        .and_then(|t| t.as_object())
    {
        for (task, cfg) in tasks {
            if let Some(sched) = cfg.get("schedule").and_then(|s| s.as_str()) {
                map.insert(task.clone(), sched.to_string());
            }
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_dreamer_task_schedules() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.jsonc");
        std::fs::write(
            &path,
            "{ \"dreamer\": { \"tasks\": { \"verify\": { \"schedule\": \"0 3 * * *\" }, \"curate\": { \"schedule\": \"\" } } } }",
        )
        .unwrap();
        let map = read_dreamer_task_schedules(&path);
        assert_eq!(map.get("verify").map(String::as_str), Some("0 3 * * *"));
        assert_eq!(map.get("curate").map(String::as_str), Some(""));
        assert_eq!(map.get("missing"), None);
    }

    #[test]
    fn strips_comments_and_trailing_commas() {
        let input = "{\n  // line\n  \"a\": 1, /* block */\n  \"b\": [1, 2,],\n}";
        let parsed: serde_json::Value = serde_json::from_str(&strip_jsonc(input)).unwrap();
        assert_eq!(parsed["a"], 1);
        assert_eq!(parsed["b"], serde_json::json!([1, 2]));
    }

    #[test]
    fn strips_a_trailing_comma_followed_by_a_comment() {
        let input = "{\n  \"dreamer\": {\n    \"tasks\": { \"verify\": { \"schedule\": \"0 3 * * *\" }, // last\n    },\n  }, /* block */\n  \"b\": [1, 2, /* two */ ],\n}";
        let parsed: serde_json::Value = serde_json::from_str(&strip_jsonc(input))
            .unwrap_or_else(|e| panic!("stripped JSONC must parse: {e}"));
        assert_eq!(
            parsed["dreamer"]["tasks"]["verify"]["schedule"],
            "0 3 * * *"
        );
        assert_eq!(parsed["b"], serde_json::json!([1, 2]));
    }

    #[test]
    fn preserves_comment_like_text_inside_strings() {
        let input = "{ \"url\": \"http://x/y\", \"note\": \"a // b\" }";
        let parsed: serde_json::Value = serde_json::from_str(&strip_jsonc(input)).unwrap();
        assert_eq!(parsed["url"], "http://x/y");
        assert_eq!(parsed["note"], "a // b");
    }

    #[test]
    fn does_not_strip_commas_inside_string_values() {
        // A `,}` / `,]` sequence INSIDE a string value must survive — the
        // trailing-comma pass must be string-state-aware.
        let input = "{ \"a\": \"x,}y\", \"b\": \"p,]q\", \"c\": [1, 2,] }";
        let parsed: serde_json::Value = serde_json::from_str(&strip_jsonc(input)).unwrap();
        assert_eq!(parsed["a"], "x,}y");
        assert_eq!(parsed["b"], "p,]q");
        assert_eq!(parsed["c"], serde_json::json!([1, 2]));
    }

    #[test]
    fn preserves_non_ascii_utf8() {
        // Byte-casting (`byte as char`) would mojibake multi-byte code points.
        let input = "{ \"path\": \"/Users/José/café\", \"emoji\": \"🌙\", \"cjk\": \"日本語\", }";
        let parsed: serde_json::Value = serde_json::from_str(&strip_jsonc(input)).unwrap();
        assert_eq!(parsed["path"], "/Users/José/café");
        assert_eq!(parsed["emoji"], "🌙");
        assert_eq!(parsed["cjk"], "日本語");
    }

    #[test]
    fn detects_dreamer_block_presence() {
        let dir = tempfile::tempdir().unwrap();
        let with = dir.path().join("with.jsonc");
        std::fs::write(&with, "{\n  // c\n  \"dreamer\": { \"model\": \"x\" },\n}").unwrap();
        assert!(config_has_dreamer_block(&with));

        let empty = dir.path().join("empty.jsonc");
        std::fs::write(&empty, "{ \"dreamer\": {} }").unwrap();
        assert!(!config_has_dreamer_block(&empty));

        let without = dir.path().join("without.jsonc");
        std::fs::write(&without, "{ \"enabled\": true }").unwrap();
        assert!(!config_has_dreamer_block(&without));

        let missing = dir.path().join("missing.jsonc");
        assert!(!config_has_dreamer_block(&missing));
    }
}
