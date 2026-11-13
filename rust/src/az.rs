//! Reading Azure DevOps with `az`, read-only: the board's items, their links, pull requests and each type's states.

use crate::settings::{Settings, org};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashMap},
    future::Future,
};
use wings_plugin::{
    azure::{WorkItems, api_org, work_items},
    cache::Cached,
    cli::{Cli, CliError, Kind},
    task::map_limit,
};

/// How many az calls run at once.
const PARALLEL: usize = 6;
/// The Azure DevOps application id, which `az rest` gets a token for.
const DEVOPS_RESOURCE: &str = "499b84ac-1321-427f-aa17-267ca6975798";

/// Why a call failed, and whether `az` isn't signed in.
#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub message: String,
    pub signed_out: bool,
}

impl From<CliError> for Failure {
    fn from(error: CliError) -> Self {
        Self { signed_out: error.kind == Kind::SignedOut, message: error.message }
    }
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self { message, signed_out: false }
    }
}

impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

impl Failure {
    /// What went wrong, in one line: the last line of az's message that isn't a warning.
    pub fn line(&self) -> String {
        line_of(&self.message)
    }
}

pub fn line_of(text: &str) -> String {
    text.split('\n').map(str::trim).rfind(|l| !l.is_empty() && !l.starts_with("WARNING")).map_or_else(|| text.to_owned(), str::to_owned)
}

thread_local! {
    static AZ: Cli = Cli::new("az", "Azure CLI", |stderr| stderr.to_lowercase().contains("login"), &["login", "--allow-no-subscriptions", "--output", "none"]);
    /// Counts az calls, for the detection's report.
    static CALLS: Cell<u32> = const { Cell::new(0) };
    static LOADERS: RefCell<HashMap<String, WorkItems>> = RefCell::new(HashMap::new());
    static TYPES: Cached<(String, String), BTreeMap<String, TypeInfo>> = Cached::new(f64::INFINITY, 0.0, |(org, project): (String, String)| async move {
        let args = ["devops", "invoke", "--area", "wit", "--resource", "workItemTypes", "--route-parameters", &format!("project={project}"), "--api-version", "7.1"];
        let out = az_json(&args, Some(&org)).await.map_err(|e| e.message)?;
        Ok(out["value"].as_array().into_iter().flatten().map(|t| (text(&t["name"]), type_info(t))).collect())
    });
}

pub fn cli() -> Cli {
    AZ.with(Cli::clone)
}

pub fn calls() -> u32 {
    CALLS.with(Cell::get)
}

pub fn reset_calls() {
    CALLS.with(|c| c.set(0));
}

/// A value as the text JavaScript's `String(value)` makes of it, which is empty for what the board leaves out.
pub fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Runs a read-only az command for an organization (none for a local one like `az account show`) and parses its JSON,
/// null when it printed nothing.
pub async fn az_json(args: &[&str], organization: Option<&str>) -> Result<Value, Failure> {
    let organization = organization.filter(|o| !o.is_empty());
    CALLS.with(|c| c.set(c.get() + 1));
    let mut all: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
    if let Some(organization) = organization {
        all.extend(["--organization".to_owned(), organization.to_owned()]);
    }
    all.extend(["-o".to_owned(), "json".to_owned()]);
    Ok(cli().json(&all, organization.unwrap_or_default(), false, Some(Value::Null)).await?)
}

/// `az_json` for the organization of the settings.
pub async fn az(args: &[&str], s: &Settings) -> Result<Value, Failure> {
    az_json(args, Some(&org(s))).await
}

#[derive(Clone, Debug)]
pub struct Item {
    pub id: u64,
    pub title: String,
    pub kind: String,
    pub state: String,
    pub assignee: Option<String>,
    pub tags: Vec<String>,
    pub blocked_by: String,
    pub parent: Option<u64>,
    pub iteration: String,
    pub changed: String,
    pub created: String,
    pub points: Vec<Option<f64>>,
    pub login: Option<String>,
    pub rev: u64,
    pub comments: u64,
}

fn fields(s: &Settings) -> String {
    let mut all: Vec<&str> = ["System.Id", "System.Title", "System.WorkItemType", "System.State", "System.AssignedTo", "System.Tags", "System.Parent", "System.IterationPath", "System.ChangedDate", "System.CreatedDate", "System.Rev", "System.CommentCount"].into();
    if !s.blocked_by_field.is_empty() {
        all.push(&s.blocked_by_field);
    }
    all.extend(s.point_fields.iter().map(String::as_str));
    all.into_iter().map(|f| format!("[{f}]")).collect::<Vec<_>>().join(", ")
}

/// A flat WIQL query. `az boards query` reads the selected fields itself, 200 ids per request.
pub async fn query(wher: &str, s: &Settings) -> Result<Vec<Item>, Failure> {
    let wiql = format!("SELECT {} FROM WorkItems WHERE {wher}", fields(s));
    let rows = az(&["boards", "query", "--wiql", &wiql, "--project", &s.project], s).await?;
    Ok(rows.as_array().into_iter().flatten().map(|row| to_item(row, s)).collect())
}

pub fn tags_of(value: &Value) -> Vec<String> {
    text(value).split(';').map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned).collect()
}

fn to_item(row: &Value, s: &Settings) -> Item {
    let f = &row["fields"];
    let who = |key: &str| f["System.AssignedTo"][key].as_str().map(str::to_owned);
    Item {
        id: row["id"].as_u64().unwrap_or(0),
        title: text(&f["System.Title"]),
        kind: text(&f["System.WorkItemType"]),
        state: text(&f["System.State"]),
        assignee: who("displayName"),
        tags: tags_of(&f["System.Tags"]),
        blocked_by: if s.blocked_by_field.is_empty() { String::new() } else { text(&f[s.blocked_by_field.as_str()]).trim().to_owned() },
        parent: f["System.Parent"].as_u64(),
        iteration: text(&f["System.IterationPath"]),
        changed: text(&f["System.ChangedDate"]),
        created: text(&f["System.CreatedDate"]),
        points: s.point_fields.iter().map(|p| f[p.as_str()].as_f64()).collect(),
        login: who("uniqueName"),
        rev: f["System.Rev"].as_u64().or_else(|| row["rev"].as_u64()).unwrap_or(0),
        comments: f["System.CommentCount"].as_u64().unwrap_or(0),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Relation {
    pub rel: String,
    pub url: String,
}

/// The item's links. Items asked in the same turn go out as one `az rest` call, 200 at most.
pub fn relations(id: u64, s: &Settings) -> impl Future<Output = Result<Vec<Relation>, Failure>> + use<> {
    let organization = org(s);
    let loader = LOADERS.with(|loaders| loaders.borrow_mut().entry(organization.clone()).or_insert_with(|| work_items(&cli(), &organization, false)).clone());
    let asked = loader.get(id);
    async move {
        let item = asked.await?;
        Ok(item.iter().flat_map(|item| item["relations"].as_array().into_iter().flatten()).map(|r| Relation { rel: text(&r["rel"]), url: text(&r["url"]) }).collect())
    }
}

/// A pull request a work item links to, with the project it is in.
#[derive(Clone, Debug, PartialEq)]
pub struct PullRequestRef {
    pub id: u64,
    pub project: String,
}

/// What `decodeURIComponent` makes of `text`; a sequence that isn't UTF-8 stays as it is.
fn decode_component(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = bytes.get(at + 1..at + 3).and_then(|pair| std::str::from_utf8(pair).ok()).and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match (bytes[at], hex) {
            (b'%', Some(byte)) => {
                out.push(byte);
                at += 3;
            }
            (byte, _) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Pull requests from ArtifactLinks like vstfs:///Git/PullRequestId/{projectId}%2F{repositoryId}%2F{prId}.
pub fn pull_request_refs(rels: &[Relation]) -> Vec<PullRequestRef> {
    const PREFIX: &str = "vstfs:///git/pullrequestid/";
    rels.iter()
        .filter(|r| r.rel == "ArtifactLink" && r.url.to_lowercase().starts_with(PREFIX))
        .filter_map(|r| {
            let decoded = decode_component(&r.url);
            let parts: Vec<&str> = decoded.split('/').collect();
            let id = parts.last()?.parse::<u64>().ok().filter(|id| *id > 0)?;
            Some(PullRequestRef { id, project: parts.len().checked_sub(3).map_or(String::new(), |at| parts[at].to_owned()) })
        })
        .collect()
}

pub fn pull_request_ids(rels: &[Relation]) -> Vec<u64> {
    pull_request_refs(rels).iter().map(|p| p.id).collect()
}

/// Pull requests per call of the project's list: 500 keep an answer near 3 MB, and `exec` gives up past 8 MB.
const PR_PAGE: usize = 500;
/// Pages read before the rest are asked for one by one.
const PR_PAGES: usize = 4;

async fn pull_request_rest(url: &str, organization: &str) -> Result<Value, Failure> {
    CALLS.with(|c| c.set(c.get() + 1));
    let args = ["rest", "--resource", DEVOPS_RESOURCE, "--url", url, "-o", "json"].map(str::to_owned);
    Ok(cli().json(&args, organization, false, None).await?)
}

/// The status and title of pull requests. The newest first of a project's list answer for many at once, a few calls in
/// all; one older than that is asked for by id.
pub async fn pull_requests(refs: &[PullRequestRef], s: &Settings) -> Result<HashMap<u64, (String, String)>, Failure> {
    let base = api_org(&org(s));
    let organization = org(s);
    let mut found = HashMap::new();
    let take = |found: &mut HashMap<u64, (String, String)>, id: u64, row: &Value| {
        found.insert(id, (text(&row["status"]), text(&row["title"])));
    };
    let mut projects: Vec<&str> = Vec::new();
    for r in refs {
        if !projects.contains(&r.project.as_str()) {
            projects.push(&r.project);
        }
    }
    for project in projects {
        let mut wanted: Vec<u64> = Vec::new();
        for r in refs.iter().filter(|r| r.project == project) {
            if !wanted.contains(&r.id) {
                wanted.push(r.id);
            }
        }
        let oldest = wanted.iter().copied().min().unwrap_or(0);
        let mut page = 0;
        while page < PR_PAGES && !wanted.is_empty() {
            let url = format!("{base}/{project}/_apis/git/pullrequests?searchCriteria.status=all&$top={PR_PAGE}&$skip={}&api-version=7.1", page * PR_PAGE);
            let answer = pull_request_rest(&url, &organization).await?;
            let rows = answer["value"].as_array().map_or(&[][..], Vec::as_slice);
            for row in rows {
                let id = row["pullRequestId"].as_u64().unwrap_or(0);
                if let Some(at) = wanted.iter().position(|w| *w == id) {
                    wanted.remove(at);
                    take(&mut found, id, row);
                }
            }
            // Newest first: a page that reaches the oldest one we want, or the end of the list, has all there is.
            if rows.len() < PR_PAGE || rows.iter().any(|row| row["pullRequestId"].as_u64().is_some_and(|id| id <= oldest)) {
                break;
            }
            page += 1;
        }
    }
    let mut rest: Vec<u64> = Vec::new();
    for r in refs {
        if !found.contains_key(&r.id) && !rest.contains(&r.id) {
            rest.push(r.id);
        }
    }
    let rows = map_limit(rest, PARALLEL, |id| {
        let url = format!("{base}/_apis/git/pullrequests/{id}?api-version=7.1");
        let organization = organization.clone();
        async move { pull_request_rest(&url, &organization).await.map(|row| (id, row)) }
    })
    .await;
    for row in rows {
        let (id, row) = row?;
        take(&mut found, id, &row);
    }
    Ok(found)
}

/// Work item ids a relation of this kind points to.
pub fn linked(rels: &[Relation], rel: &str) -> Vec<u64> {
    rels.iter().filter(|r| r.rel == rel).filter_map(|r| r.url.rsplit('/').next()?.parse().ok()).collect()
}

pub const PREDECESSOR: &str = "System.LinkTypes.Dependency-Reverse";
pub const RELATED: &str = "System.LinkTypes.Related";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StateInfo {
    pub name: String,
    pub category: String,
    pub color: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TypeInfo {
    pub color: String,
    pub states: Vec<StateInfo>,
}

pub fn hex(color: &Value) -> String {
    let c = text(color);
    if c.len() == 6 && c.chars().all(|c| c.is_ascii_hexdigit()) { format!("#{c}") } else { "#888888".to_owned() }
}

/// A type of `workItemTypes` with its states in board order.
pub fn type_info(t: &Value) -> TypeInfo {
    TypeInfo {
        color: hex(&t["color"]),
        states: t["states"].as_array().into_iter().flatten().map(|x| StateInfo { name: text(&x["name"]), category: text(&x["category"]), color: hex(&x["color"]) }).collect(),
    }
}

/// Each project's work item types: their colour, and their states in board order with each state's category (Proposed,
/// InProgress, Resolved, Completed, Removed) and colour. Read once per project, since a process rarely changes.
pub struct States {
    pub types: BTreeMap<String, TypeInfo>,
}

impl States {
    pub fn category(&self, kind: &str, state: &str) -> &str {
        self.types.get(kind).and_then(|t| t.states.iter().find(|x| x.name == state)).map_or("", |x| &x.category)
    }

    /// The first state of a type in this category, like "In Progress".
    pub fn first_of(&self, kind: &str, category: &str) -> Option<&str> {
        self.types.get(kind)?.states.iter().find(|x| x.category == category).map(|x| x.name.as_str())
    }
}

/// One call reads every type of the project with its states.
pub async fn load_states(s: &Settings) -> Result<States, Failure> {
    let types = TYPES.with(Cached::clone).get((org(s), s.project.clone())).await?;
    Ok(States { types })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(rel: &str, url: &str) -> Relation {
        Relation { rel: rel.into(), url: url.into() }
    }

    #[test]
    fn a_failure_is_the_last_line_that_is_not_a_warning() {
        assert_eq!(line_of("WARNING: x\nERROR: Please run 'az login'.\nWARNING: y\n"), "ERROR: Please run 'az login'.");
        assert_eq!(line_of("WARNING: only"), "WARNING: only");
    }

    #[test]
    fn pull_requests_are_read_from_artifact_links_with_their_projects() {
        let rels = [
            rel("ArtifactLink", "vstfs:///Git/PullRequestId/proj%2Frepo%2F42"),
            rel("ArtifactLink", "VSTFS:///GIT/PULLREQUESTID/p2%2Fr%2F7"),
            rel("ArtifactLink", "vstfs:///Git/Commit/p%2Fr%2Fabc"),
            rel("Hyperlink", "vstfs:///Git/PullRequestId/p%2Fr%2F9"),
            rel("ArtifactLink", "vstfs:///Git/PullRequestId/p%2Fr%2F0"),
        ];
        assert_eq!(pull_request_refs(&rels), [PullRequestRef { id: 42, project: "proj".into() }, PullRequestRef { id: 7, project: "p2".into() }]);
        assert_eq!(linked(&[rel(PREDECESSOR, "https://x/_apis/wit/workItems/12"), rel(RELATED, "https://x/_apis/wit/workItems/13")], PREDECESSOR), [12]);
    }

    #[test]
    fn a_row_becomes_an_item_with_the_fields_the_settings_name() {
        let s = Settings { blocked_by_field: "Custom.Blocker".into(), point_fields: vec!["Effort".into(), "Size".into()], ..Settings::default() };
        let row = serde_json::json!({ "id": 5, "rev": 3, "fields": {
            "System.Title": "Login", "System.WorkItemType": "Task", "System.State": "Active",
            "System.AssignedTo": { "displayName": "Ada", "uniqueName": "ada@x" }, "System.Tags": "a; b ;",
            "System.Parent": 4, "Custom.Blocker": " #9 ", "Effort": 3, "System.CommentCount": 2 } });
        let item = to_item(&row, &s);
        assert_eq!((item.id, item.title.as_str(), item.assignee.as_deref(), item.login.as_deref(), item.parent), (5, "Login", Some("Ada"), Some("ada@x"), Some(4)));
        assert_eq!((item.tags, item.blocked_by.as_str(), item.points, item.rev, item.comments), (vec!["a".into(), "b".into()], "#9", vec![Some(3.0), None], 3, 2));
    }
}
