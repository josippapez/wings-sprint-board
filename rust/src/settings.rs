//! What the settings steps save, and what a check needs from them. Kept in `wings.storage` under `settings`, as the
//! TypeScript build did, so an install keeps its settings across the update.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wings_plugin::settings::Setting;

/// Settings start empty or with neutral defaults. Empty lists and fields turn their check off.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub org: String,
    pub project: String,
    pub team: String,
    /// Empty uses the team's areas.
    pub area_path: String,
    pub members: Vec<String>,
    pub story_types: Vec<String>,
    /// A story is in scope when it has a child of one of these types. Empty puts every story in scope.
    pub scope_child_types: Vec<String>,
    /// Children of an in-scope story that are checked too.
    pub child_types: Vec<String>,
    /// Other sprint items in scope when assigned to a team member or titled with one of the prefixes.
    pub item_types: Vec<String>,
    pub title_prefixes: Vec<String>,
    pub code_review_states: Vec<String>,
    pub blocked_by_field: String,
    pub goal_tag: String,
    pub added_tags: Vec<String>,
    pub point_types: Vec<String>,
    pub point_fields: Vec<String>,
    pub parked_pr_prefix: String,
    pub stale_days: u32,
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| (*v).to_owned()).collect()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            org: String::new(),
            project: String::new(),
            team: String::new(),
            area_path: String::new(),
            members: Vec::new(),
            story_types: strings(&["User Story", "Product Backlog Item"]),
            scope_child_types: strings(&["Task"]),
            child_types: strings(&["Task", "Bug"]),
            item_types: strings(&["Bug"]),
            title_prefixes: Vec::new(),
            code_review_states: strings(&["Code Review", "In Code Review"]),
            blocked_by_field: String::new(),
            goal_tag: String::new(),
            added_tags: Vec::new(),
            point_types: Vec::new(),
            point_fields: strings(&["Microsoft.VSTS.Scheduling.StoryPoints"]),
            parked_pr_prefix: String::new(),
            stale_days: 3,
        }
    }
}

/// What the settings steps save. Main reads it and hears it change, and the sidebar writes it.
pub fn saved() -> Setting<Settings> {
    Setting::new("settings", Settings::default(), |stored| serde_json::from_value(stored.clone()).ok(), |settings| serde_json::to_value(settings).unwrap_or(Value::Null))
}

/// What's still missing before a check can run.
pub fn missing(s: &Settings) -> Vec<String> {
    [("Organization", s.org.trim().is_empty()), ("Project", s.project.trim().is_empty()), ("Team", s.team.trim().is_empty()), ("Team members", s.members.is_empty())]
        .into_iter()
        .filter(|(_, empty)| *empty)
        .map(|(name, _)| name.to_owned())
        .collect()
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `https://dev.azure.com/<name>`, with at most one slash after it.
fn is_org(org: &str) -> bool {
    let Some(rest) = org.strip_prefix("https://dev.azure.com/") else { return false };
    let name = rest.strip_suffix('/').unwrap_or(rest);
    !name.is_empty() && name.chars().all(|c| is_word(c) || c == '.' || c == '-')
}

/// The organization the steps accept, around spaces.
pub fn valid_org(org: &str) -> bool {
    is_org(org.trim())
}

/// A field reference name like `Custom.MyField`.
fn is_ref_name(field: &str) -> bool {
    let mut chars = field.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.all(|c| is_word(c) || c == '.')
}

/// Errors when a setting would break a query, since they go into WIQL and az arguments.
pub fn validate(s: &Settings) -> Result<(), String> {
    if !is_org(&s.org) {
        return Err("Organization must look like https://dev.azure.com/<name>.".into());
    }
    for field in std::iter::once(&s.blocked_by_field).chain(&s.point_fields).filter(|f| !f.is_empty()) {
        if !is_ref_name(field) {
            return Err(format!("\"{field}\" isn't a field reference name like Custom.MyField."));
        }
    }
    for (name, value) in [("project", &s.project), ("team", &s.team), ("areaPath", &s.area_path)] {
        // Wings refuses az arguments starting with "-" or "@".
        if value.starts_with(['-', '@']) {
            return Err(format!("{name} can't start with - or @."));
        }
    }
    Ok(())
}

/// Wings refuses az arguments starting with "-" or "@".
pub fn safe_arg(value: &str) -> bool {
    !value.trim().is_empty() && !value.starts_with(['-', '@'])
}

pub fn org_url(org: &str) -> String {
    org.trim().trim_end_matches('/').to_owned()
}

pub fn org(s: &Settings) -> String {
    s.org.trim_end_matches('/').to_owned()
}

/// Encodes what `encodeURIComponent` does: everything but letters, digits and `-_.!~*'()`.
pub fn encode_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn item_url(org: &str, project: &str, id: u64) -> String {
    format!("{}/{}/_workitems/edit/{id}", org.trim_end_matches('/'), encode_component(project))
}

pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub fn list(values: &[String]) -> String {
    values.iter().map(|v| quote(v)).collect::<Vec<_>>().join(", ")
}

/// Whether `values` has `value`, ignoring case.
pub fn has_ci(values: &[String], value: &str) -> bool {
    let value = value.to_lowercase();
    values.iter().any(|v| v.to_lowercase() == value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn what_an_older_install_saved_loads_and_what_it_lacks_takes_the_default() {
        let old = json!({ "org": "https://dev.azure.com/acme", "project": "Web", "team": "Web Team", "members": ["Ada"], "staleDays": 5 });
        let s: Settings = serde_json::from_value(old).unwrap();
        assert_eq!((s.org.as_str(), s.stale_days, s.members.as_slice()), ("https://dev.azure.com/acme", 5, &["Ada".to_owned()][..]));
        assert_eq!(s.story_types, ["User Story", "Product Backlog Item"]);
        assert_eq!(s.code_review_states, ["Code Review", "In Code Review"]);
        assert_eq!(serde_json::to_value(&s).unwrap()["areaPath"], "");
    }

    #[test]
    fn an_empty_board_is_missing_what_the_steps_ask_for() {
        assert_eq!(missing(&Settings::default()), ["Organization", "Project", "Team", "Team members"]);
        let s = Settings { org: "o".into(), project: "p".into(), team: "t".into(), members: vec!["a".into()], ..Settings::default() };
        assert!(missing(&s).is_empty());
    }

    #[test]
    fn a_setting_that_would_break_a_query_is_refused() {
        let ok = Settings { org: "https://dev.azure.com/acme".into(), project: "Web".into(), team: "T".into(), ..Settings::default() };
        assert_eq!(validate(&ok), Ok(()));
        let bad = |change: fn(&mut Settings)| {
            let mut s = ok.clone();
            change(&mut s);
            validate(&s).unwrap_err()
        };
        assert_eq!(bad(|s| s.org = "https://example.com/x".into()), "Organization must look like https://dev.azure.com/<name>.");
        assert_eq!(bad(|s| s.blocked_by_field = "Custom Field".into()), "\"Custom Field\" isn't a field reference name like Custom.MyField.");
        assert_eq!(bad(|s| s.point_fields = vec!["1x".into()]), "\"1x\" isn't a field reference name like Custom.MyField.");
        assert_eq!(bad(|s| s.team = "-x".into()), "team can't start with - or @.");
        assert_eq!(bad(|s| s.area_path = "@x".into()), "areaPath can't start with - or @.");
        assert!(valid_org("https://dev.azure.com/acme/") && !valid_org("https://dev.azure.com/acme//") && !valid_org("https://dev.azure.com/"));
    }

    #[test]
    fn queries_quote_and_urls_encode() {
        assert_eq!(quote("O'Brien"), "'O''Brien'");
        assert_eq!(list(&["Task".into(), "Bug".into()]), "'Task', 'Bug'");
        assert_eq!(item_url("https://dev.azure.com/acme/", "My Proj", 7), "https://dev.azure.com/acme/My%20Proj/_workitems/edit/7");
        assert!(has_ci(&["Task".into()], "task"));
    }
}
