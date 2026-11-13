//! Settings for the Sprint board sidebar: works out as much as it can with read-only az and git calls, shows it for one
//! click, and offers pickers to correct any of it.

use super::{
    lists::{self, Loaded, Person, ProjectMeta, SprintData, SprintItem},
    with,
};
use crate::{
    az::{self, line_of},
    settings::{self, Settings, org_url, safe_arg, valid_org},
    state::Phase,
};
use serde_json::Value;
use std::{collections::{HashMap, HashSet}, rc::Rc};
use wings_plugin::{
    azure::{api_org, parse_remote},
    cache::Cached,
    git, host,
    task::{join, join_all, spawn},
};

/// Categories of types that aren't board work, like test cases and code review requests.
const NOT_WORK: [&str; 8] = ["Hidden", "Test", "SharedStep", "SharedParameter", "CodeReview", "Feedback", "Epic", "Feature"];

/// The settings keys that hold one text value.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Text {
    Org,
    Project,
    Team,
    BlockedByField,
    GoalTag,
    ParkedPrPrefix,
}

impl Text {
    pub fn name(self) -> &'static str {
        match self {
            Text::Org => "org",
            Text::Project => "project",
            Text::Team => "team",
            Text::BlockedByField => "blockedByField",
            Text::GoalTag => "goalTag",
            Text::ParkedPrPrefix => "parkedPrPrefix",
        }
    }

    pub fn get(self, s: &Settings) -> &str {
        match self {
            Text::Org => &s.org,
            Text::Project => &s.project,
            Text::Team => &s.team,
            Text::BlockedByField => &s.blocked_by_field,
            Text::GoalTag => &s.goal_tag,
            Text::ParkedPrPrefix => &s.parked_pr_prefix,
        }
    }

    pub fn set(self, s: &mut Settings, value: String) {
        *match self {
            Text::Org => &mut s.org,
            Text::Project => &mut s.project,
            Text::Team => &mut s.team,
            Text::BlockedByField => &mut s.blocked_by_field,
            Text::GoalTag => &mut s.goal_tag,
            Text::ParkedPrPrefix => &mut s.parked_pr_prefix,
        } = value;
    }
}

/// The settings keys that hold a list of values.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Many {
    Members,
    StoryTypes,
    ScopeChildTypes,
    ChildTypes,
    ItemTypes,
    TitlePrefixes,
    CodeReviewStates,
    AddedTags,
    PointTypes,
    PointFields,
}

impl Many {
    pub fn name(self) -> &'static str {
        match self {
            Many::Members => "members",
            Many::StoryTypes => "storyTypes",
            Many::ScopeChildTypes => "scopeChildTypes",
            Many::ChildTypes => "childTypes",
            Many::ItemTypes => "itemTypes",
            Many::TitlePrefixes => "titlePrefixes",
            Many::CodeReviewStates => "codeReviewStates",
            Many::AddedTags => "addedTags",
            Many::PointTypes => "pointTypes",
            Many::PointFields => "pointFields",
        }
    }

    pub fn get(self, s: &Settings) -> &Vec<String> {
        match self {
            Many::Members => &s.members,
            Many::StoryTypes => &s.story_types,
            Many::ScopeChildTypes => &s.scope_child_types,
            Many::ChildTypes => &s.child_types,
            Many::ItemTypes => &s.item_types,
            Many::TitlePrefixes => &s.title_prefixes,
            Many::CodeReviewStates => &s.code_review_states,
            Many::AddedTags => &s.added_tags,
            Many::PointTypes => &s.point_types,
            Many::PointFields => &s.point_fields,
        }
    }

    pub fn set(self, s: &mut Settings, values: Vec<String>) {
        *match self {
            Many::Members => &mut s.members,
            Many::StoryTypes => &mut s.story_types,
            Many::ScopeChildTypes => &mut s.scope_child_types,
            Many::ChildTypes => &mut s.child_types,
            Many::ItemTypes => &mut s.item_types,
            Many::TitlePrefixes => &mut s.title_prefixes,
            Many::CodeReviewStates => &mut s.code_review_states,
            Many::AddedTags => &mut s.added_tags,
            Many::PointTypes => &mut s.point_types,
            Many::PointFields => &mut s.point_fields,
        } = values;
    }
}

/// The settings form's values while it's open. Typing in Working days leaves text in `stale_text` until it's saved.
#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    pub s: Settings,
    pub stale_text: Option<String>,
}

/// An Azure DevOps repo open in Wings.
#[derive(Clone, Debug, PartialEq)]
pub struct Repo {
    pub org: String,
    pub project: String,
    pub panes: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Detection {
    pub notes: Vec<String>,
    pub off: Vec<String>,
    pub calls: u32,
    pub ms: f64,
}

/// What the lists load for: the organization, project and team as they were when typing stopped or a pick was made.
#[derive(Clone, Default)]
pub struct Settled {
    pub org: String,
    pub project: String,
    pub team: String,
}

#[derive(Default)]
pub struct Setup {
    /// The settings form's values while it's open.
    pub draft: Option<Draft>,
    pub settled: Settled,
    /// Text typed into "Other…" fields, by setting key.
    pub other: HashMap<&'static str, String>,
    /// What each checkbox list had ticked when the form opened. Those go first, and stay put while you tick.
    pub ticked_first: HashMap<&'static str, HashSet<String>>,
    /// What detection is reading now.
    pub detecting: Option<String>,
    pub detection: Option<Detection>,
    pub detect_error: Option<String>,
    pub panes: Option<Vec<Value>>,
    /// Azure DevOps repos open in Wings, most panes first.
    pub repos: Vec<Repo>,
    /// The step on screen.
    pub step: usize,
    /// Goes up with each typed value, so only the last one settles.
    typing: u64,
}

impl Setup {
    /// Shows the form with `s`, its first step, nothing typed.
    fn open(&mut self, s: Settings) {
        self.step = 0;
        self.other.clear();
        self.ticked_first.clear();
        self.settle_now(&s);
        self.draft = Some(Draft { s, stale_text: None });
    }

    pub fn settle_now(&mut self, s: &Settings) {
        self.settled = Settled { org: s.org.clone(), project: s.project.clone(), team: s.team.clone() };
    }
}

/// Lets the lists that depend on what was typed load once typing stops.
pub fn settle() {
    let number = with(|s| {
        s.setup.typing += 1;
        s.setup.typing
    });
    spawn(async move {
        host::sleep(500).await;
        with(|s| {
            if s.setup.typing == number
                && let Some(draft) = s.setup.draft.clone()
            {
                s.setup.settle_now(&draft.s);
            }
        });
    });
}

// ---------- open repos ----------

thread_local! {
    /// The Azure DevOps organization and project a folder's origin is in, or none. A folder is read once.
    static REMOTES: Cached<String, Option<(String, String)>> = Cached::new(f64::INFINITY, 0.0, |cwd: String| async move {
        Ok(git::ok(&cwd, &["remote", "get-url", "origin"]).await.and_then(|url| parse_remote(&url)).map(|r| (api_org(&r.org), r.project)))
    });
}

async fn find_repos() {
    let mut cwds: Vec<String> = Vec::new();
    for pane in with(|s| s.setup.panes.clone().unwrap_or_default()) {
        let cwd = pane["cwd"].as_str().unwrap_or_default().to_owned();
        if !cwd.is_empty() && !cwds.contains(&cwd) {
            cwds.push(cwd);
        }
    }
    cwds.truncate(12);
    type Remote = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<(String, String)>, String>>>>;
    let found = join_all(cwds.into_iter().map(|cwd| Box::pin(REMOTES.with(Cached::clone).get(cwd)) as Remote).collect()).await;
    let mut repos: Vec<Repo> = Vec::new();
    for (org, project) in found.into_iter().filter_map(|r| r.ok().flatten()) {
        match repos.iter_mut().find(|r| r.org == org && r.project == project) {
            Some(known) => known.panes += 1,
            None => repos.push(Repo { org, project, panes: 1 }),
        }
    }
    // Most panes first; repos with as many keep the order their panes came in.
    repos.sort_by_key(|r| std::cmp::Reverse(r.panes));
    with(|s| s.setup.repos = repos);
}

// ---------- detection ----------

/// Counts of each value, most common first.
pub fn counted<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<(String, usize)> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for v in values {
        match counts.iter_mut().find(|(name, _)| name == v) {
            Some(known) => known.1 += 1,
            None => counts.push((v.to_owned(), 1)),
        }
    }
    counts.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    counts
}

/// What a signed-out az says, as the CLI tells it apart.
fn signed_out(message: &str) -> bool {
    message.to_lowercase().contains("login")
}

/// Fills the form with what can be worked out. Keeps an organization, project and team already picked.
pub async fn detect() {
    with(|s| {
        s.setup.detecting = Some("Looking for Azure DevOps repos open in Wings…".to_owned());
        s.setup.detect_error = None;
    });
    az::reset_calls();
    let started = host::now();
    let (mut notes, mut off) = (Vec::new(), Vec::new());
    if let Err(error) = read_everything(&mut notes, &mut off, started).await {
        with(|s| {
            let line = line_of(&error);
            s.setup.detect_error = Some(if signed_out(&error) { format!("az isn't signed in. {line}") } else { line });
            s.setup.detecting = None;
            if s.setup.draft.is_none() {
                let settings = s.settings();
                s.setup.open(settings);
            }
        });
    }
}

fn step(text: &str) {
    with(|s| s.setup.detecting = Some(text.to_owned()));
}

async fn read_everything(notes: &mut Vec<String>, off: &mut Vec<String>, started: f64) -> Result<(), String> {
    find_repos().await;
    let (base, main_settings, repos) = with(|s| (s.setup.draft.as_ref().map(|d| d.s.clone()), s.settings(), s.setup.repos.clone()));
    let defaults = base.clone().unwrap_or(main_settings);
    let repo = repos.first();
    let base_org = base.as_ref().map_or("", |b| b.org.as_str());
    let base_project = base.as_ref().map_or("", |b| b.project.trim());
    let base_team = base.as_ref().map_or("", |b| b.team.trim());
    let org = if valid_org(base_org) { org_url(base_org) } else { repo.map_or(String::new(), |r| r.org.clone()) };
    let project = if !base_project.is_empty() { base_project.to_owned() } else { repo.filter(|r| r.org == org).map_or(String::new(), |r| r.project.clone()) };
    let place = |settings: Settings| Settings { org: org.clone(), project: project.clone(), ..settings };
    if org.is_empty() || project.is_empty() {
        notes.push("No Azure DevOps repo is open in Wings. Pick the organization and project, then detect again.".to_owned());
        finish(place(defaults), notes, off, started);
        return Ok(());
    }
    notes.push(if !base_project.is_empty() {
        format!("Project as picked: {project}.")
    } else {
        format!("From your open repos: {project}{}.", if repos.len() > 1 { format!(" ({} other repo{} found)", repos.len() - 1, if repos.len() > 2 { "s" } else { "" }) } else { String::new() })
    });

    step("Reading the project's teams, types and fields…");
    let meta = lists::meta().need((org.clone(), project.clone())).await?;
    let mut team = base_team.to_owned();
    if team.is_empty() {
        // Of your teams with a current sprint, the one with the most items, then the most of them yours.
        let sprints = meta.my_teams.iter().take(5).map(|t| {
            let (key, name) = ((org.clone(), project.clone(), t.clone()), t.clone());
            let asked = lists::sprint().need(key);
            Box::pin(async move { asked.await.ok().map(|d| (name, d)) }) as std::pin::Pin<Box<dyn std::future::Future<Output = Option<(String, Rc<SprintData>)>>>>
        });
        let (me, sprints) = join(async { lists::me().need(()).await.unwrap_or_default() }, join_all(sprints.collect())).await;
        let mine = |d: &SprintData| d.items.iter().filter(|i| !me.is_empty() && i.assignee_login.as_deref().is_some_and(|l| l.to_lowercase() == me.to_lowercase())).count();
        let mut sprints: Vec<(String, Rc<SprintData>)> = sprints.into_iter().flatten().collect();
        sprints.sort_by(|a, b| b.1.items.len().cmp(&a.1.items.len()).then(mine(&b.1).cmp(&mine(&a.1))));
        team = sprints.first().map_or(String::new(), |(t, _)| t.clone());
        notes.push(if !team.is_empty() {
            format!("From the teams you're in: {team}{}.", if meta.my_teams.len() > 1 { format!(" (1 of {}, the one with the most sprint items; change it below)", meta.my_teams.len()) } else { String::new() })
        } else if !meta.my_teams.is_empty() {
            "None of your teams has a current sprint. Pick a team, then detect again.".to_owned()
        } else {
            "You're not in a team of this project. Pick a team, then detect again.".to_owned()
        });
    }
    if team.is_empty() {
        finish(place(defaults), notes, off, started);
        return Ok(());
    }

    step("Reading the team's current sprint…");
    let key = (org.clone(), project.clone(), team.clone());
    let (data, (members, me)) = join(lists::sprint().need(key.clone()), join(lists::members().need(key), async { lists::me().need(()).await.unwrap_or_default() })).await;
    let (data, members) = (data?, members?);
    let inferred = infer(&meta, &data, &members, &me, &defaults, notes, off);
    let area_path = base.map_or(String::new(), |b| b.area_path);
    finish(Settings { org, project, team, area_path, ..inferred }, notes, off, started);
    Ok(())
}

fn finish(settings: Settings, notes: &[String], off: &[String], started: f64) {
    with(|s| {
        s.setup.open(settings);
        s.setup.detection = Some(Detection { notes: notes.to_vec(), off: off.to_vec(), calls: az::calls(), ms: host::now() - started });
        s.setup.detecting = None;
    });
}

/// `/code\s*review/i`.
fn code_review(state: &str) -> bool {
    let lower = state.to_lowercase();
    lower.match_indices("code").any(|(at, word)| lower[at + word.len()..].trim_start().starts_with("review"))
}

fn is_set(i: &SprintItem, field: &str) -> bool {
    i.field_text(field).is_some()
}

/// Works out the scope and rules from the project and the sprint.
pub fn infer(meta: &ProjectMeta, data: &SprintData, team_members: &[Person], me: &str, defaults: &Settings, notes: &mut Vec<String>, off: &mut Vec<String>) -> Settings {
    let items = &data.items;
    let requirement = meta.category("Microsoft.RequirementCategory");
    let not_work: HashSet<&str> = meta.categories.iter().filter(|(reference, _)| NOT_WORK.iter().any(|w| reference.contains(w))).flat_map(|(_, types)| types.iter().map(String::as_str)).collect();
    let mut present: Vec<&str> = Vec::new();
    for i in items {
        if !present.contains(&i.kind.as_str()) {
            present.push(&i.kind);
        }
    }
    let story_types: Vec<String> = if requirement.iter().any(|t| present.contains(&t.as_str())) { requirement.iter().filter(|t| present.contains(&t.as_str())).cloned().collect() } else { requirement.to_vec() };
    let story_ids: HashSet<u64> = items.iter().filter(|i| story_types.contains(&i.kind)).map(|i| i.id).collect();
    let kids: Vec<&SprintItem> = items.iter().filter(|i| i.parent.is_some_and(|p| story_ids.contains(&p))).collect();
    let child_types: Vec<String> = counted(kids.iter().map(|i| i.kind.as_str())).into_iter().map(|(t, _)| t).collect();

    // Members: you. Teammates are added on purpose.
    let me_lower = me.to_lowercase();
    let mine_by_login = |login: &Option<String>| !me.is_empty() && login.as_deref().is_some_and(|l| l.to_lowercase() == me_lower);
    let me_name = if me.is_empty() { None } else { items.iter().find(|i| mine_by_login(&i.assignee_login)).and_then(|i| i.assignee.clone()).or_else(|| team_members.iter().find(|m| m.login.to_lowercase() == me_lower).map(|m| m.name.clone())) };
    let members: Vec<String> = me_name.into_iter().collect();

    let mine: Vec<&&SprintItem> = kids.iter().filter(|i| i.assignee.as_ref().is_some_and(|a| members.contains(a))).collect();
    let scope_child_types: Vec<String> = counted(mine.iter().map(|i| i.kind.as_str())).into_iter().map(|(t, _)| t).collect();
    let top_level: Vec<&SprintItem> = items.iter().filter(|i| !i.parent.is_some_and(|p| story_ids.contains(&p)) && !story_types.contains(&i.kind) && !not_work.contains(i.kind.as_str())).collect();
    let item_types: Vec<String> = counted(top_level.iter().map(|i| i.kind.as_str())).into_iter().map(|(t, _)| t).collect();

    let checked: HashSet<&String> = story_types.iter().chain(&child_types).chain(&item_types).collect();
    let mut states: Vec<&str> = Vec::new();
    for t in meta.types.iter().filter(|t| checked.contains(&t.name)) {
        for s in &t.states {
            if !states.contains(&s.name.as_str()) {
                states.push(&s.name);
            }
        }
    }
    let by_code_review: Vec<String> = states.iter().filter(|s| code_review(s)).map(|s| (*s).to_owned()).collect();
    let code_review_states = if by_code_review.is_empty() { states.iter().filter(|s| s.to_lowercase().contains("review")).map(|s| (*s).to_owned()).collect() } else { by_code_review };

    let mut block_fields = data.block_fields.clone();
    let count = |f: &str| items.iter().filter(|i| is_set(i, f)).count();
    block_fields.sort_by_key(|f| std::cmp::Reverse(count(f)));
    let blocked_by_field = block_fields.first().cloned().unwrap_or_default();
    let point_fields: Vec<String> = data.point_fields.iter().filter(|f| items.iter().any(|i| is_set(i, f))).cloned().collect();
    let pointed = |i: &SprintItem| point_fields.iter().any(|f| i.values[f.as_str()].as_f64().or_else(|| i.values[f.as_str()].as_str().and_then(|t| t.trim().parse().ok())).is_some_and(|n| n > 0.0));
    let point_types: Vec<String> = present
        .iter()
        .filter(|t| {
            let of_type: Vec<&SprintItem> = items.iter().filter(|i| i.kind == **t).collect();
            of_type.iter().filter(|i| pointed(i)).count() as f64 >= f64::max(2.0, of_type.len() as f64 / 2.0)
        })
        .map(|t| (*t).to_owned())
        .collect();

    let tags = counted(items.iter().flat_map(|i| i.tags.iter().map(String::as_str)));
    let goal: Vec<&(String, usize)> = tags.iter().filter(|(t, _)| t.to_lowercase().contains("goal") && !t.to_lowercase().contains("stretch") && !t.to_lowercase().contains("added")).collect();
    let added: Vec<&(String, usize)> = tags.iter().filter(|(t, _)| t.to_lowercase().contains("added") || t.to_lowercase().contains("stretch")).collect();

    notes.push(if !items.is_empty() {
        format!("From {} ({} items): types, review states, fields and tags.", data.sprint.name, items.len())
    } else {
        format!("{} has 0 items in the team's area, so the types, fields and tags below are guesses. Check the team and area path.", data.sprint.name)
    });
    notes.push(if members.is_empty() { "Couldn't match your az sign-in to anyone in the sprint. Tick yourself below.".to_owned() } else { "You're ticked as the team member. Add teammates if you watch their work too.".to_owned() });
    if scope_child_types.is_empty() && !child_types.is_empty() {
        notes.push("None of the stories' children is assigned to a ticked member, so every story is in scope until you pick scope child types.".to_owned());
    }
    if blocked_by_field.is_empty() {
        off.push("Blocked By checks: no text field with \"block\" in its name.".to_owned());
    }
    if goal.is_empty() {
        off.push("Lower-priority test: no tag with \"goal\" on sprint items.".to_owned());
    }
    if added.is_empty() {
        off.push("Added without tags: no tag with \"added\" or \"stretch\" on sprint items.".to_owned());
    }
    if point_fields.is_empty() || point_types.is_empty() {
        off.push("Missing points: no type in the sprint usually carries points.".to_owned());
    }
    if code_review_states.is_empty() {
        off.push("Status ahead of the PR for review states: no state with \"review\" in its name.".to_owned());
    }

    Settings {
        members,
        story_types,
        scope_child_types,
        child_types,
        item_types,
        title_prefixes: Vec::new(),
        code_review_states,
        blocked_by_field,
        goal_tag: goal.first().map_or(String::new(), |(t, _)| t.clone()),
        added_tags: added.iter().map(|(t, _)| t.clone()).collect(),
        point_types,
        point_fields,
        parked_pr_prefix: String::new(),
        stale_days: 3,
        ..defaults.clone()
    }
}

/// Starts detection once the setup form is needed and Wings has said which panes are open.
pub fn maybe_detect() {
    let start = with(|s| s.main.as_ref().is_some_and(|m| m.phase == Phase::Setup) && s.setup.panes.is_some() && s.setup.detecting.is_none() && s.setup.detection.is_none() && s.setup.detect_error.is_none());
    if start {
        spawn(detect());
    }
}

pub fn on_panes(list: &[Value]) {
    let first = with(|s| {
        let first = s.setup.panes.is_none();
        s.setup.panes = Some(list.to_vec());
        first
    });
    if first {
        maybe_detect();
    }
}

// ---------- the form ----------

/// Opens the settings at the first step.
pub fn open_settings() {
    with(|s| {
        let settings = s.settings();
        s.setup.open(settings);
    });
}

/// Saves the form.
pub async fn save() {
    let Some(d) = with(|s| s.setup.draft.clone()) else { return };
    // Typing in Working days leaves text there; a number that isn't one is the default.
    let days = d.stale_text.as_deref().map_or(f64::from(d.s.stale_days), |t| t.trim().parse::<f64>().ok().filter(|n| n.is_finite() && *n != 0.0).unwrap_or(3.0));
    let saved = Settings {
        org: org_url(&d.s.org),
        project: d.s.project.trim().to_owned(),
        team: d.s.team.trim().to_owned(),
        area_path: d.s.area_path.trim().to_owned(),
        stale_days: (days + 0.5).floor().max(1.0) as u32,
        ..d.s
    };
    let outcome = settings::saved().set(saved.clone());
    with(|s| match outcome {
        Err(error) => s.local_error = Some(line_of(&error)),
        Ok(()) => {
            s.setup.draft = None;
            s.setup.detection = None;
            s.local_error = None;
            if let Some(main) = &mut s.main {
                main.phase = Phase::Loading;
                main.settings = saved;
                main.error = None;
            }
        }
    });
}

// ---------- the stepper ----------

/// Weekdays after `iso`'s day up to today.
pub fn working_days_ago(iso: &str) -> u32 {
    crate::check::working_days_since(iso, host::now())
}

/// What the steps read: the draft, the lists loaded for it, and the team's sprint.
pub struct Ctx {
    pub d: Settings,
    pub org: String,
    pub project: String,
    pub team: String,
    pub org_ok: bool,
    pub projects: Option<Loaded<Rc<Vec<String>>>>,
    pub meta: Option<Loaded<Rc<ProjectMeta>>>,
    pub m: Option<Rc<ProjectMeta>>,
    pub sprint: Option<Loaded<Rc<SprintData>>>,
    pub data: Option<Rc<SprintData>>,
    pub members: Option<Loaded<Rc<Vec<Person>>>>,
    pub me: Option<String>,
    pub type_names: Option<Vec<String>>,
}

pub fn context(setup: &Setup) -> Ctx {
    let d = setup.draft.as_ref().map(|d| d.s.clone()).unwrap_or_default();
    let (org, project, team) = (org_url(&setup.settled.org), setup.settled.project.trim().to_owned(), setup.settled.team.trim().to_owned());
    let org_ok = valid_org(&org);
    let projects = org_ok.then(|| lists::projects().want(org.clone()));
    let meta = (org_ok && safe_arg(&project)).then(|| lists::meta().want((org.clone(), project.clone())));
    let m = meta.as_ref().and_then(|l| l.value.clone());
    let team_ok = m.as_ref().is_some_and(|m| safe_arg(&team) && m.teams.contains(&team));
    let key = (org.clone(), project.clone(), team.clone());
    let sprint = team_ok.then(|| lists::sprint().want(key.clone()));
    let members = team_ok.then(|| lists::members().want(key));
    let me = lists::me().want(()).value;
    let data = sprint.as_ref().and_then(|l| l.value.clone());
    let type_names = m.as_ref().map(|m| {
        let mut names: Vec<String> = m.types.iter().map(|t| t.name.clone()).collect();
        names.sort();
        names
    });
    Ctx { d, org, project, team, org_ok, projects, meta, m, sprint, data, members, me, type_names }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{az::StateInfo, check::Sprint};
    use serde_json::json;
    use wings_plugin::task::block_on;

    fn item(id: u64, kind: &str, who: Option<&str>, parent: Option<u64>, tags: &[&str], values: Value) -> SprintItem {
        SprintItem {
            id,
            title: format!("Item {id}"),
            kind: kind.into(),
            state: "Active".into(),
            assignee: who.map(str::to_owned),
            assignee_login: who.map(|w| format!("{}@x", w.to_lowercase())),
            tags: tags.iter().map(|t| (*t).to_owned()).collect(),
            parent,
            created: String::new(),
            changed: String::new(),
            values,
        }
    }

    fn meta() -> ProjectMeta {
        let states = |names: &[&str]| names.iter().map(|n| StateInfo { name: (*n).into(), category: "InProgress".into(), color: "#000000".into() }).collect();
        let ty = |name: &str, names: &[&str]| lists::WorkItemType { name: name.into(), color: "#111111".into(), states: states(names) };
        ProjectMeta {
            types: vec![ty("User Story", &["New", "Active", "Code Review", "Closed"]), ty("Task", &["New", "Active", "Closed"]), ty("Bug", &["New", "In Review", "Closed"]), ty("Test Case", &["Design"])],
            categories: vec![("Microsoft.RequirementCategory".into(), vec!["User Story".into()]), ("Microsoft.TestCaseCategory".into(), vec!["Test Case".into()])],
            fields: vec![],
            tags: vec![],
            teams: vec!["Web Team".into()],
            my_teams: vec!["Web Team".into()],
        }
    }

    #[test]
    fn detection_picks_the_stories_their_tasks_your_scope_and_the_rules_the_sprint_shows() {
        let sprint = SprintData {
            sprint: Sprint { name: "Sprint 1".into(), path: "Web\\Sprint 1".into(), start: None, finish: None },
            block_fields: vec!["Custom.Other".into(), "Custom.Blocker".into()],
            point_fields: vec!["Microsoft.VSTS.Scheduling.StoryPoints".into(), "Microsoft.VSTS.Scheduling.Effort".into()],
            items: vec![
                item(1, "User Story", Some("Ada"), None, &["Sprint goal", "Added later"], json!({ "Microsoft.VSTS.Scheduling.StoryPoints": 3, "Custom.Blocker": "#9" })),
                item(2, "Task", Some("Ada"), Some(1), &[], json!({ "Custom.Blocker": "x", "Custom.Other": "y" })),
                item(3, "Task", Some("Bob"), Some(1), &[], json!({})),
                item(4, "Bug", None, None, &["Stretch"], json!({ "Microsoft.VSTS.Scheduling.StoryPoints": 2 })),
                item(5, "User Story", None, None, &["Goal stretch"], json!({ "Microsoft.VSTS.Scheduling.StoryPoints": 5 })),
                item(6, "Test Case", None, None, &[], json!({})),
            ],
        };
        let (mut notes, mut off) = (Vec::new(), Vec::new());
        let s = infer(&meta(), &sprint, &[], "ADA@x", &Settings::default(), &mut notes, &mut off);
        assert_eq!((s.story_types.clone(), s.child_types.clone(), s.members.clone(), s.scope_child_types.clone()), (vec!["User Story".to_owned()], vec!["Task".to_owned()], vec!["Ada".to_owned()], vec!["Task".to_owned()]));
        // Test cases aren't board work; a bug at the top level is.
        assert_eq!(s.item_types, ["Bug"]);
        assert_eq!(s.code_review_states, ["Code Review"]);
        assert_eq!((s.blocked_by_field.as_str(), s.goal_tag.as_str(), s.added_tags.clone()), ("Custom.Blocker", "Sprint goal", vec!["Added later".to_owned(), "Stretch".to_owned(), "Goal stretch".to_owned()]));
        assert_eq!((s.point_fields.clone(), s.point_types.clone()), (vec!["Microsoft.VSTS.Scheduling.StoryPoints".to_owned()], vec!["User Story".to_owned()]));
        assert_eq!(notes, ["From Sprint 1 (6 items): types, review states, fields and tags.", "You're ticked as the team member. Add teammates if you watch their work too."]);
        assert!(off.is_empty());
        let (mut notes, mut off) = (Vec::new(), Vec::new());
        let bare = infer(&meta(), &SprintData { items: vec![], block_fields: vec![], point_fields: vec![], sprint: sprint.sprint.clone() }, &[], "", &Settings::default(), &mut notes, &mut off);
        assert_eq!((bare.members.is_empty(), bare.story_types.clone(), off.len()), (true, vec!["User Story".to_owned()], 4));
        assert_eq!(notes[1], "Couldn't match your az sign-in to anyone in the sprint. Tick yourself below.");
    }

    #[test]
    fn review_states_are_those_named_code_review_or_else_any_review() {
        assert!(code_review("In Code Review") && code_review("CODEREVIEW") && !code_review("In Review") && !code_review("Coded"));
        assert_eq!(counted(["b", "a", "b", "c", "a", "b"]), [("b".to_owned(), 3), ("a".to_owned(), 2), ("c".to_owned(), 1)]);
    }

    #[test]
    fn saving_keeps_the_trimmed_values_and_working_days_that_are_a_whole_number_of_at_least_one() {
        with(|s| {
            s.setup.draft = Some(Draft { s: Settings { org: " https://dev.azure.com/acme/ ".into(), project: " Web ".into(), team: "T ".into(), ..Settings::default() }, stale_text: Some("2.6".into()) });
            s.main = Some(crate::state::Published { phase: Phase::Setup, settings: Settings::default(), missing: vec![], result: None, error: None, running: false });
        });
        block_on(save());
        with(|s| {
            let main = s.main.as_ref().unwrap();
            assert_eq!((main.phase, main.settings.org.as_str(), main.settings.project.as_str(), main.settings.team.as_str(), main.settings.stale_days), (Phase::Loading, "https://dev.azure.com/acme", "Web", "T", 3));
            assert!(s.setup.draft.is_none());
            s.setup.draft = Some(Draft { s: Settings::default(), stale_text: Some("0".into()) });
        });
        block_on(save());
        with(|s| assert_eq!(s.main.as_ref().unwrap().settings.stale_days, 3));
        with(|s| s.setup.draft = Some(Draft { s: Settings::default(), stale_text: Some("-4".into()) }));
        block_on(save());
        with(|s| assert_eq!(s.main.as_ref().unwrap().settings.stale_days, 1));
    }

    /// An org with one project and team, whose sprint has one item, read by `az`; nothing is open in Wings.
    fn answering() {
        host::testing::answer(|method, params| {
            if method != "exec" {
                return Ok(Value::Null);
            }
            let args: Vec<&str> = params["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
            let ok = |v: Value| Ok(json!({ "code": 0, "stdout": v.to_string(), "stderr": "" }));
            if params["program"] == "git" {
                return Ok(json!({ "code": 0, "stdout": "git@ssh.dev.azure.com:v3/acme/Web/web", "stderr": "" }));
            }
            match (args[0], args[1], args.get(2).copied(), args.get(5).copied()) {
                ("devops", "invoke", _, Some("workItemTypes")) => ok(json!({ "value": [{ "name": "User Story", "color": "009ccc", "states": [{ "name": "New", "category": "Proposed", "color": "b2b2b2" }] }] })),
                ("devops", "invoke", _, Some("workItemTypeCategories")) => ok(json!({ "value": [{ "referenceName": "Microsoft.RequirementCategory", "workItemTypes": [{ "name": "User Story" }] }] })),
                ("devops", "invoke", _, Some("teams")) => ok(json!({ "value": [{ "name": "Web Team" }] })),
                ("devops", "invoke", ..) => ok(json!({ "value": [] })),
                ("devops", "team", Some("list"), _) => ok(json!([{ "name": "Web Team" }])),
                ("devops", "team", Some("list-member"), _) => ok(json!([{ "identity": { "displayName": "Ada", "uniqueName": "ada@x" } }])),
                ("account", "show", ..) => ok(json!("ada@x")),
                ("boards", "iteration", ..) => ok(json!([{ "name": "Sprint 1", "path": "Web\\Sprint 1", "attributes": {} }])),
                ("boards", "area", ..) => ok(json!({ "values": [{ "value": "Web", "includeChildren": true }] })),
                ("boards", "query", ..) => ok(json!([{ "id": 1, "fields": { "System.Title": "A story", "System.WorkItemType": "User Story", "System.State": "New", "System.AssignedTo": { "displayName": "Ada", "uniqueName": "ada@x" } } }])),
                other => Err(format!("unexpected {other:?}")),
            }
        });
    }

    #[test]
    fn detection_finds_the_repo_open_in_wings_its_team_and_you_and_fills_the_form() {
        answering();
        on_panes(&[json!({ "cwd": "/work/web" }), json!({ "cwd": "/work/web" }), json!({ "cwd": "/work/other" })]);
        with(|s| s.main = Some(crate::state::Published { phase: Phase::Setup, settings: Settings::default(), missing: vec![], result: None, error: None, running: false }));
        block_on(detect());
        with(|s| {
            let d = s.setup.draft.as_ref().unwrap();
            assert_eq!((d.s.org.as_str(), d.s.project.as_str(), d.s.team.as_str(), d.s.members.clone(), d.s.story_types.clone()), ("https://dev.azure.com/acme", "Web", "Web Team", vec!["Ada".to_owned()], vec!["User Story".to_owned()]));
            let detection = s.setup.detection.as_ref().unwrap();
            assert!(detection.notes[0].starts_with("From your open repos: Web (") || detection.notes[0] == "From your open repos: Web.", "{:?}", detection.notes);
            assert_eq!(s.setup.repos, [Repo { org: "https://dev.azure.com/acme".into(), project: "Web".into(), panes: 2 }]);
            assert!(s.setup.detecting.is_none() && s.setup.detect_error.is_none() && detection.calls > 0);
            assert_eq!(s.setup.settled.team, "Web Team");
        });
    }

    #[test]
    fn a_detection_that_fails_says_so_and_keeps_the_form_to_type_in() {
        host::testing::answer(|method, params| {
            if method != "exec" {
                return Ok(Value::Null);
            }
            if params["program"] == "git" {
                return Ok(json!({ "code": 0, "stdout": "git@ssh.dev.azure.com:v3/acme/Web/web", "stderr": "" }));
            }
            Ok(json!({ "code": 1, "stdout": "", "stderr": "ERROR: Please run 'az login' to setup account." }))
        });
        on_panes(&[json!({ "cwd": "/work/web" })]);
        block_on(detect());
        with(|s| {
            assert_eq!(s.setup.detect_error.as_deref(), Some("az isn't signed in. ERROR: Please run 'az login' to setup account."));
            assert!(s.setup.draft.is_some() && s.setup.detecting.is_none());
        });
    }

    #[test]
    fn a_wings_with_no_azure_repo_open_asks_for_the_organization_and_project() {
        host::testing::answer(|_, _| Ok(json!({ "code": 0, "stdout": "git@github.com:acme/web.git", "stderr": "" })));
        on_panes(&[json!({ "cwd": "/work/web" })]);
        block_on(detect());
        with(|s| {
            assert_eq!(s.setup.detection.as_ref().unwrap().notes, ["No Azure DevOps repo is open in Wings. Pick the organization and project, then detect again."]);
            assert_eq!(s.setup.draft.as_ref().unwrap().s.org, "");
        });
    }
}
