//! The lists the settings steps read from Azure DevOps, each kept in memory per organization, project and team, so a
//! render never asks for them again.

use crate::{
    az::{Failure, StateInfo, az_json, text},
    check::Sprint,
    settings::quote,
};
use serde_json::Value;
use std::{cell::RefCell, collections::HashMap, future::Future, hash::Hash, rc::Rc};
use wings_plugin::{cache::Cached, task::{join_all, spawn}};

/// What a list has for a key now: its value, why it failed, or that it is still loading.
#[derive(Clone, Debug, PartialEq)]
pub struct Loaded<T> {
    pub value: Option<T>,
    pub error: Option<String>,
    pub loading: bool,
}

impl<T> Loaded<T> {
    pub fn status(&self) -> (bool, Option<&str>) {
        (self.loading, self.error.as_deref())
    }
}

/// A list kept per key: what a render asks for (`want`), and what detection waits for (`need`).
pub struct List<K, V> {
    kept: Cached<K, V>,
    /// What a load that hasn't produced a value is doing: still waiting (none), or why it failed.
    open: Rc<RefCell<HashMap<K, Option<String>>>>,
}

impl<K, V> Clone for List<K, V> {
    fn clone(&self) -> Self {
        Self { kept: self.kept.clone(), open: self.open.clone() }
    }
}

/// Asks the host for a turn, so a task started while a page is built runs.
fn kick() {
    drop(wings_plugin::host::sleep(0));
}

impl<K: Hash + Eq + Clone + 'static, V: Clone + 'static> List<K, V> {
    pub fn new<Fut: Future<Output = Result<V, String>> + 'static>(load: impl Fn(K) -> Fut + 'static) -> Self {
        Self { kept: Cached::new(f64::INFINITY, 0.0, load), open: Rc::new(RefCell::new(HashMap::new())) }
    }

    /// Waits for a list, for detection. A failure is kept for `want`, so the page shows it without asking again.
    pub fn need(&self, key: K) -> impl Future<Output = Result<V, String>> + use<K, V> {
        let this = self.clone();
        async move {
            this.open.borrow_mut().entry(key.clone()).or_insert(None);
            let answer = this.kept.get(key.clone()).await;
            match &answer {
                Ok(_) => drop(this.open.borrow_mut().remove(&key)),
                Err(error) => drop(this.open.borrow_mut().insert(key, Some(crate::az::line_of(error)))),
            }
            answer
        }
    }

    /// What the list has for `key` now. A load that isn't started starts, and the page renders when it lands.
    pub fn want(&self, key: K) -> Loaded<V> {
        if let Some(Ok(value)) = self.kept.peek(&key) {
            return Loaded { value: Some(value), error: None, loading: false };
        }
        if let Some(known) = self.open.borrow().get(&key) {
            return Loaded { value: None, error: known.clone(), loading: known.is_none() };
        }
        let asked = self.need(key);
        spawn(async move {
            let _ = asked.await;
        });
        kick();
        Loaded { value: None, error: None, loading: true }
    }
}

pub struct WorkItemType {
    pub name: String,
    pub color: String,
    pub states: Vec<StateInfo>,
}

pub struct FieldInfo {
    pub reference: String,
    pub name: String,
    pub kind: String,
}

pub struct ProjectMeta {
    pub types: Vec<WorkItemType>,
    pub categories: Vec<(String, Vec<String>)>,
    pub fields: Vec<FieldInfo>,
    pub tags: Vec<String>,
    pub teams: Vec<String>,
    pub my_teams: Vec<String>,
}

impl ProjectMeta {
    pub fn category_of(&self, kind: &str, state: &str) -> &str {
        self.types.iter().find(|t| t.name == kind).and_then(|t| t.states.iter().find(|s| s.name == state)).map_or("", |s| &s.category)
    }

    pub fn type_color(&self, kind: &str) -> &str {
        self.types.iter().find(|t| t.name == kind).map_or("#888888", |t| &t.color)
    }

    pub fn category(&self, name: &str) -> &[String] {
        self.categories.iter().find(|(n, _)| n == name).map_or(&[], |(_, types)| types)
    }

    pub fn field(&self, reference: &str) -> Option<&FieldInfo> {
        self.fields.iter().find(|f| f.reference == reference)
    }
}

pub struct SprintItem {
    pub id: u64,
    pub title: String,
    pub kind: String,
    pub state: String,
    pub assignee: Option<String>,
    pub assignee_login: Option<String>,
    pub tags: Vec<String>,
    pub parent: Option<u64>,
    pub created: String,
    pub changed: String,
    /// The fields as `az` printed them.
    pub values: Value,
}

impl SprintItem {
    /// The text of a field the item has, trimmed, or none.
    pub fn field_text(&self, field: &str) -> Option<String> {
        let value = &self.values[field];
        (!value.is_null()).then(|| text(value).trim().to_owned()).filter(|t| !t.is_empty())
    }
}

pub struct SprintData {
    pub sprint: Sprint,
    pub items: Vec<SprintItem>,
    pub block_fields: Vec<String>,
    pub point_fields: Vec<String>,
}

pub struct TeamSprint {
    pub name: String,
    pub path: String,
    /// past, current or future.
    pub time_frame: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Person {
    pub name: String,
    pub login: String,
}

const POINT_FIELDS: [&str; 3] = ["Microsoft.VSTS.Scheduling.StoryPoints", "Microsoft.VSTS.Scheduling.Effort", "Microsoft.VSTS.Scheduling.Size"];

/// `az devops invoke`, a call of Azure DevOps' REST API.
pub async fn invoke(org: &str, resource: &str, route: &[String], query: &[&str], area: &str, version: &str) -> Result<Value, Failure> {
    let mut args = vec!["devops", "invoke", "--area", area, "--resource", resource, "--route-parameters"];
    args.extend(route.iter().map(String::as_str));
    if !query.is_empty() {
        args.push("--query-parameters");
        args.extend(query);
    }
    args.extend(["--api-version", version]);
    az_json(&args, Some(org)).await
}

/// `invoke` that owns what it needs, so calls can wait side by side.
fn invoke_owned(org: &str, resource: &str, route: Vec<String>, query: &'static [&'static str], area: &'static str, version: &'static str) -> impl Future<Output = Result<Value, Failure>> + use<> {
    let (org, resource) = (org.to_owned(), resource.to_owned());
    async move { invoke(&org, &resource, &route, query, area, version).await }
}

fn wit(org: &str, resource: &str, project: &str) -> impl Future<Output = Result<Value, Failure>> + use<> {
    invoke_owned(org, resource, vec![format!("project={project}")], &[], "wit", "7.1")
}

fn names(value: &Value) -> Vec<String> {
    value.as_array().into_iter().flatten().map(|t| text(&t["name"])).collect()
}

fn message(error: Failure) -> String {
    error.message
}

async fn meta_of((org, project): (String, String)) -> Result<Rc<ProjectMeta>, String> {
    {
        let mine = invoke_owned(&org, "teams", vec![format!("projectId={project}")], &["$mine=true"], "core", "7.1-preview");
        let teams = {
            let (org, project) = (org.clone(), project.clone());
            async move { az_json(&["devops", "team", "list", "--project", &project, "--top", "500"], Some(&org)).await }
        };
        type Call = std::pin::Pin<Box<dyn Future<Output = Result<Value, Failure>>>>;
        // $mine lists the teams the signed-in user is in, so nobody has to say who they are.
        let calls: Vec<Call> = vec![
            Box::pin(wit(&org, "workItemTypes", &project)),
            Box::pin(wit(&org, "workItemTypeCategories", &project)),
            Box::pin(wit(&org, "fields", &project)),
            Box::pin(wit(&org, "tags", &project)),
            Box::pin(teams),
            Box::pin(mine),
        ];
        let mut answers = join_all(calls).await.into_iter().collect::<Result<Vec<Value>, Failure>>().map_err(message)?.into_iter();
        let (types, categories, fields, tags, teams, mine) = (answers.next().unwrap(), answers.next().unwrap(), answers.next().unwrap(), answers.next().unwrap(), answers.next().unwrap(), answers.next().unwrap());
        let list = |v: &Value| v["value"].as_array().cloned().unwrap_or_default();
        let mut tags = names(&Value::Array(list(&tags)));
        tags.sort_by_key(|t| t.to_lowercase());
        let mut teams = names(&teams);
        teams.sort();
        Ok(Rc::new(ProjectMeta {
            types: list(&types)
                .iter()
                .filter(|t| t["isDisabled"] != true)
                .map(|t| {
                    let info = crate::az::type_info(t);
                    WorkItemType { name: text(&t["name"]), color: info.color, states: info.states }
                })
                .collect(),
            categories: list(&categories).iter().map(|c| (text(&c["referenceName"]), names(&c["workItemTypes"]))).collect(),
            fields: list(&fields).iter().map(|f| FieldInfo { reference: text(&f["referenceName"]), name: text(&f["name"]), kind: text(&f["type"]) }).collect(),
            tags,
            teams,
            my_teams: names(&Value::Array(list(&mine))),
        }))
    }
}

fn block_fields(meta: &ProjectMeta) -> Vec<String> {
    meta.fields.iter().filter(|f| ["string", "plainText"].contains(&f.kind.as_str()) && format!("{} {}", f.reference, f.name).to_lowercase().contains("block")).map(|f| f.reference.clone()).collect()
}

/// The team's areas as WIQL, each path with or without its children, as on the team's board.
fn area_clause(area: &Value) -> Result<String, String> {
    let values = area["values"].as_array().map_or(&[][..], Vec::as_slice);
    if values.is_empty() {
        return Err("The team has no areas.".into());
    }
    Ok(values.iter().map(|v| format!("[System.AreaPath] {} {}", if v["includeChildren"] == true { "UNDER" } else { "=" }, quote(&text(&v["value"])))).collect::<Vec<_>>().join(" OR "))
}

/// The team's current sprint and its items, with the fields detection looks at. Three calls.
async fn sprint_of((org, project, team): (String, String, String), meta: Rc<ProjectMeta>) -> Result<Rc<SprintData>, String> {
    let (iterations, area) = wings_plugin::task::join(
        az_json(&["boards", "iteration", "team", "list", "--team", &team, "--timeframe", "current", "--project", &project], Some(&org)),
        az_json(&["boards", "area", "team", "list", "--team", &team, "--project", &project], Some(&org)),
    )
    .await;
    let (iterations, area) = (iterations.map_err(message)?, area.map_err(message)?);
    let Some(it) = iterations.as_array().and_then(|l| l.first()) else { return Err(format!("{team} has no current sprint.")) };
    let block_fields = block_fields(&meta);
    let point_fields: Vec<String> = POINT_FIELDS.iter().filter(|f| meta.field(f).is_some()).map(|f| (*f).to_owned()).collect();
    let select = ["System.Id", "System.Title", "System.WorkItemType", "System.State", "System.AssignedTo", "System.Tags", "System.Parent", "System.CreatedDate", "System.ChangedDate"]
        .iter()
        .map(|f| (*f).to_owned())
        .chain(block_fields.iter().cloned())
        .chain(point_fields.iter().cloned())
        .map(|f| format!("[{f}]"))
        .collect::<Vec<_>>()
        .join(", ");
    let path = text(&it["path"]);
    let wiql = format!("SELECT {select} FROM WorkItems WHERE [System.TeamProject] = {} AND [System.IterationPath] = {} AND ({}) AND [System.State] <> 'Removed'", quote(&project), quote(&path), area_clause(&area)?);
    let rows = az_json(&["boards", "query", "--wiql", &wiql, "--project", &project], Some(&org)).await.map_err(message)?;
    let who = |f: &Value, key: &str| f["System.AssignedTo"][key].as_str().map(str::to_owned);
    Ok(Rc::new(SprintData {
        sprint: Sprint { name: text(&it["name"]), path, start: it["attributes"]["startDate"].as_str().map(str::to_owned), finish: it["attributes"]["finishDate"].as_str().map(str::to_owned) },
        block_fields,
        point_fields,
        items: rows
            .as_array()
            .into_iter()
            .flatten()
            .map(|r| {
                let f = &r["fields"];
                SprintItem {
                    id: r["id"].as_u64().unwrap_or(0),
                    title: text(&f["System.Title"]),
                    kind: text(&f["System.WorkItemType"]),
                    state: text(&f["System.State"]),
                    assignee: who(f, "displayName"),
                    assignee_login: who(f, "uniqueName"),
                    tags: crate::az::tags_of(&f["System.Tags"]),
                    parent: f["System.Parent"].as_u64(),
                    created: text(&f["System.CreatedDate"]),
                    changed: text(&f["System.ChangedDate"]),
                    values: f.clone(),
                }
            })
            .collect(),
    }))
}

thread_local! {
    static PROJECTS: List<String, Rc<Vec<String>>> = List::new(|org: String| async move {
        let out = az_json(&["devops", "project", "list", "--top", "500"], Some(&org)).await.map_err(message)?;
        let list = if out.is_array() { &out } else { &out["value"] };
        let mut names = names(list);
        names.sort();
        Ok(Rc::new(names))
    });
    static META: List<(String, String), Rc<ProjectMeta>> = List::new(meta_of);
    static SPRINT: List<(String, String, String), Rc<SprintData>> = List::new(|key: (String, String, String)| async move {
        let meta = META.with(List::clone).need((key.0.clone(), key.1.clone())).await?;
        sprint_of(key, meta).await
    });
    static TEAM_SPRINTS: List<(String, String, String), Rc<Vec<TeamSprint>>> = List::new(|(org, project, team): (String, String, String)| async move {
        let out = az_json(&["boards", "iteration", "team", "list", "--team", &team, "--project", &project], Some(&org)).await.map_err(message)?;
        Ok(Rc::new(out.as_array().into_iter().flatten().map(|it| TeamSprint { name: text(&it["name"]), path: text(&it["path"]), time_frame: text(&it["attributes"]["timeFrame"]) }).collect()))
    });
    static MEMBERS: List<(String, String, String), Rc<Vec<Person>>> = List::new(|(org, project, team): (String, String, String)| async move {
        let out = az_json(&["devops", "team", "list-member", "--team", &team, "--project", &project, "--top", "500"], Some(&org)).await.map_err(message)?;
        Ok(Rc::new(
            out.as_array()
                .into_iter()
                .flatten()
                .map(|m| &m["identity"])
                .filter(|i| i["isContainer"] != true && i["displayName"].as_str().is_some_and(|n| !n.is_empty()))
                .map(|i| Person { name: text(&i["displayName"]), login: text(&i["uniqueName"]) })
                .collect(),
        ))
    });
    /// Everyone in the organization, so the people step can find someone who isn't in the team or the sprint.
    static ORG_USERS: List<String, Rc<Vec<Person>>> = List::new(|org: String| async move {
        let out = az_json(&["devops", "user", "list", "--top", "10000"], Some(&org)).await.map_err(message)?;
        Ok(Rc::new(
            out["members"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|m| &m["user"])
                .filter(|u| u["displayName"].as_str().is_some_and(|n| !n.is_empty()) && u["subjectKind"] != "group")
                .map(|u| {
                    let mail = text(&u["mailAddress"]);
                    Person { name: text(&u["displayName"]), login: if mail.is_empty() { text(&u["principalName"]) } else { mail } }
                })
                .collect(),
        ))
    });
    /// The signed-in az account, read locally.
    static ME: List<(), String> = List::new(|()| async {
        Ok(text(&az_json(&["account", "show", "--query", "user.name"], None).await.map_err(message)?))
    });
}

pub fn projects() -> List<String, Rc<Vec<String>>> {
    PROJECTS.with(List::clone)
}

/// Types with their states, type categories, fields, tags, teams and your teams: six calls, once per project.
pub fn meta() -> List<(String, String), Rc<ProjectMeta>> {
    META.with(List::clone)
}

pub fn sprint() -> List<(String, String, String), Rc<SprintData>> {
    SPRINT.with(List::clone)
}

/// The team's sprints, past, current and future, in date order. One call.
pub fn team_sprints() -> List<(String, String, String), Rc<Vec<TeamSprint>>> {
    TEAM_SPRINTS.with(List::clone)
}

pub fn members() -> List<(String, String, String), Rc<Vec<Person>>> {
    MEMBERS.with(List::clone)
}

pub fn org_users() -> List<String, Rc<Vec<Person>>> {
    ORG_USERS.with(List::clone)
}

pub fn me() -> List<(), String> {
    ME.with(List::clone)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wings_plugin::{host, task::block_on};

    #[test]
    fn a_list_loads_once_and_a_failure_is_kept_for_the_page_to_show_without_asking_again() {
        let runs = Rc::new(std::cell::Cell::new(0));
        let counted = runs.clone();
        let list: List<String, usize> = List::new(move |key: String| {
            counted.set(counted.get() + 1);
            async move { if key == "bad" { Err("WARNING: x\nERROR: no".to_owned()) } else { Ok(key.len()) } }
        });
        let asked = list.clone();
        assert_eq!(block_on(async move { asked.need("abc".into()).await }), Ok(3));
        assert_eq!(list.want("abc".into()), Loaded { value: Some(3), error: None, loading: false });
        let asked = list.clone();
        assert!(block_on(async move { asked.need("bad".into()).await }).is_err());
        assert_eq!(list.want("bad".into()).status(), (false, Some("ERROR: no")));
        assert_eq!(runs.get(), 2);
    }

    #[test]
    fn the_projects_teams_and_meta_of_a_project_are_read_once_each() {
        host::testing::answer(|_, params| {
            let args: Vec<&str> = params["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
            let ok = |v: Value| Ok(json!({ "code": 0, "stdout": v.to_string(), "stderr": "" }));
            match (args[0], args[1], args.get(5).copied()) {
                ("devops", "project", _) => ok(json!({ "value": [{ "name": "Web" }, { "name": "Api" }] })),
                ("devops", "team", _) => ok(json!([{ "name": "B team" }, { "name": "A team" }])),
                ("devops", "invoke", Some("workItemTypes")) => ok(json!({ "value": [{ "name": "Task", "color": "f2cb1d", "states": [{ "name": "New", "category": "Proposed", "color": "b2b2b2" }] }, { "name": "Hidden", "isDisabled": true }] })),
                ("devops", "invoke", Some("workItemTypeCategories")) => ok(json!({ "value": [{ "referenceName": "Microsoft.RequirementCategory", "workItemTypes": [{ "name": "User Story" }] }] })),
                ("devops", "invoke", Some("fields")) => ok(json!({ "value": [{ "referenceName": "Custom.Blocker", "name": "Blocker", "type": "string" }] })),
                ("devops", "invoke", Some("tags")) => ok(json!({ "value": [{ "name": "b" }, { "name": "A" }] })),
                ("devops", "invoke", Some("teams")) => ok(json!({ "value": [{ "name": "A team" }] })),
                other => Err(format!("unexpected {other:?}")),
            }
        });
        let projects = block_on(async { projects().need("https://dev.azure.com/acme".into()).await }).unwrap();
        assert_eq!(*projects, ["Api", "Web"]);
        let meta = block_on(async { meta().need(("https://dev.azure.com/acme".into(), "Web".into())).await }).unwrap();
        assert_eq!((meta.teams.clone(), meta.my_teams.clone(), meta.tags.clone()), (vec!["A team".to_owned(), "B team".to_owned()], vec!["A team".to_owned()], vec!["A".to_owned(), "b".to_owned()]));
        assert_eq!((meta.types.len(), meta.type_color("Task"), meta.category_of("Task", "New"), meta.category("Microsoft.RequirementCategory")), (1, "#f2cb1d", "Proposed", &["User Story".to_owned()][..]));
        assert_eq!(block_fields(&meta), ["Custom.Blocker"]);
    }
}
