//! The setup steps: one question each, the detected answer picked, a "why" line, and a live preview from the real
//! sprint of what the answer does.

use super::{
    kit::{avatar, badge, dot, em_space, field, field_group, gap, muted_small},
    lists::{Person, SprintItem},
    pickers::{Many_, One, edit, list_status, pick_many, pick_one, text_field},
    setup::{Ctx, Many, Setup, Text, counted, settle, working_days_ago},
};
use crate::settings::Settings;
use std::rc::Rc;
use wings_plugin::{
    format::parse_time,
    ui::{Node, muted, row, stack, text},
};

pub struct Step {
    pub id: &'static str,
    pub question: &'static str,
    pub explain: &'static str,
    pub optional: bool,
}

/// The steps. `ready` says whether Next is allowed, `off` clears an optional check.
pub const STEPS: [Step; 10] = [
    Step { id: "where", question: "Where is your board?", explain: "The Azure DevOps organization and project your team's sprint lives in.", optional: false },
    Step { id: "team", question: "Which team's sprint?", explain: "The board shows the current sprint of this team, in the areas the team owns.", optional: false },
    Step {
        id: "people",
        question: "Whose work do you follow?",
        explain: "The board checks and \"Working on\" cover these people. You're picked; add teammates you look after. The board's own Everyone / Mine filter doesn't depend on this.",
        optional: false,
    },
    Step {
        id: "stories",
        question: "Which work items are stories, and which are the tasks under them?",
        explain: "A story is the piece of work a board row stands for; tasks are its children. If only some stories are your team's, say which tasks mark them.",
        optional: false,
    },
    Step {
        id: "other",
        question: "Any other work your team does outside stories?",
        explain: "Work items of these types count as your team's when one of your people has them, or their title starts with a prefix.",
        optional: true,
    },
    Step {
        id: "blocked",
        question: "Where do you write what blocks an item?",
        explain: "A text field holding the blocking ticket's number. Items with it set get a red Blocked mark, and the checks flag text that isn't a ticket number, or a ticket that's already closed.",
        optional: true,
    },
    Step {
        id: "goal",
        question: "Which tag marks the sprint's priority work?",
        explain: "Items with this tag, or under a story with it, are goal work. The checks tell you when someone has only blocked or non-goal work left.",
        optional: true,
    },
    Step {
        id: "added",
        question: "How do you mark work added after the sprint started?",
        explain: "Items created after the sprint started should carry these tags. Types that need points must have every point field set, and equal when there are several. Titles with \"spike\" are exempt.",
        optional: true,
    },
    Step {
        id: "review",
        question: "Which states mean \"in code review\"?",
        explain: "In these states an item should have an open pull request. The checks flag one whose pull request is already merged or missing, and a done item whose pull request is still open.",
        optional: true,
    },
    Step { id: "stale", question: "When is in-progress work stale?", explain: "An item in progress with no change for this many working days is listed as stale. Weekends don't count.", optional: false },
];

fn type_color(c: &Ctx, kind: &str) -> String {
    c.m.as_ref().and_then(|m| m.types.iter().find(|t| t.name == kind)).map_or("#888888".to_owned(), |t| t.color.clone())
}

/// A board row as the sidebar will draw it, for previews.
fn preview_row(c: &Ctx, i: &SprintItem, chips: Vec<Node>) -> Node {
    gap(row(), "s")
        .key(i.id.to_string())
        .child(dot(&type_color(c, &i.kind)))
        .child(muted(i.id.to_string()).prop("mono", true).prop("size", "tiny"))
        .child(text(i.title.as_str()).prop("size", "small").prop("truncate", true).prop("grow", true))
        .children(chips)
        .child(avatar(i.assignee.as_deref()))
}

/// The preview card under a step.
fn preview(caption: &str, body: Vec<Node>) -> Node {
    gap(stack(), "s").child(text(caption).prop("size", "tiny").prop("weight", "strong").prop("tone", "muted")).children(body)
}

fn no_example() -> Node {
    muted_small("No example in this sprint.").key("none")
}

fn wait_for(c: &Ctx) -> Option<Node> {
    list_status(c.sprint.as_ref(), "the sprint").or_else(|| c.data.is_none().then(|| muted_small("Pick a team to see an example.")))
}

/// Items assigned to the chosen people.
fn people_items(c: &Ctx) -> Vec<&SprintItem> {
    c.data.as_ref().map_or_else(Vec::new, |d| d.items.iter().filter(|i| i.assignee.as_ref().is_some_and(|a| c.d.members.contains(a))).collect())
}

fn category_of(c: &Ctx, i: &SprintItem) -> String {
    c.m.as_ref().map_or(String::new(), |m| m.category_of(&i.kind, &i.state).to_owned())
}

fn shown_rows(c: &Ctx, items: &[&SprintItem], most: usize, chips: impl Fn(&SprintItem) -> Vec<Node>) -> Vec<Node> {
    if items.is_empty() { vec![no_example()] } else { items.iter().take(most).map(|i| preview_row(c, i, chips(i))).collect() }
}

fn one<'a>(setup: &Setup, label: &str, key: Text, options: Option<&[String]>, o: One<'a>) -> Node {
    let current = setup.draft.as_ref().map_or("", |d| key.get(&d.s));
    pick_one(label, key, current, options, setup.other.get(key.name()).map(String::as_str), o)
}

fn many(setup: &Setup, key: Many, options: Option<&[String]>, o: Many_) -> Node {
    let values = setup.draft.as_ref().map_or(&[][..], |d| key.get(&d.s).as_slice());
    pick_many(key, values, options, setup.other.get(key.name()).map_or("", String::as_str), setup.ticked_first.get(key.name()), o)
}

fn plain() -> Many_<'static> {
    Many_ { labels: None, extra: None, suggest: None }
}

fn sprint_count_labels<'a>(counts: &'a [(String, usize)]) -> impl Fn(&str) -> String + 'a {
    |t| match counts.iter().find(|(name, _)| name == t) {
        Some((_, n)) if *n > 0 => format!("{t} · {n} in sprint"),
        _ => t.to_owned(),
    }
}

impl Step {
    /// Whether Next is allowed.
    pub fn ready(&self, c: &Ctx) -> bool {
        match self.id {
            "where" => c.org_ok && !c.project.is_empty(),
            "team" => c.m.as_ref().is_some_and(|m| m.teams.contains(&c.team)),
            "people" => !c.d.members.is_empty(),
            _ => true,
        }
    }

    /// Clears an optional check.
    pub fn off(&self, d: &mut Settings) {
        match self.id {
            "other" => {
                d.item_types.clear();
                d.title_prefixes.clear();
            }
            "blocked" => d.blocked_by_field.clear(),
            "goal" => d.goal_tag.clear(),
            "added" => {
                d.added_tags.clear();
                d.point_types.clear();
            }
            "review" => d.code_review_states.clear(),
            _ => {}
        }
    }

    /// Why the detected answer was picked.
    pub fn why(&self, c: &Ctx, setup: &Setup) -> Option<String> {
        match self.id {
            "where" => {
                if let Some(repo) = setup.repos.iter().find(|r| r.org == c.org && r.project == c.project) {
                    Some(format!("Found in {} of the repos open in Wings.", repo.panes))
                } else if setup.repos.is_empty() {
                    Some("No Azure DevOps repo is open in Wings, so pick it here.".to_owned())
                } else {
                    None
                }
            }
            "team" => c.m.as_ref().filter(|m| m.my_teams.contains(&c.team)).map(|m| {
                let n = m.my_teams.len();
                format!("You're in {n} team{} here{}.", if n > 1 { "s" } else { "" }, if n > 1 { "; this one has the most items in its current sprint" } else { "" })
            }),
            "people" => {
                let me = c.me.as_deref().filter(|me| !me.is_empty())?;
                let only = (c.d.members.len() == 1).then(|| &c.d.members[0])?;
                c.data.as_ref()?.items.iter().any(|i| i.assignee_login.as_deref().is_some_and(|l| l.to_lowercase() == me.to_lowercase()) && i.assignee.as_ref() == Some(only)).then(|| "You're signed in to az as this person.".to_owned())
            }
            "stories" => c.m.as_ref().map(|_| "Stories come from the process's requirement types; tasks are the types found under them in this sprint.".to_owned()),
            "other" => Some("These types sit on the sprint board outside stories.".to_owned()),
            "blocked" => {
                let data = c.data.as_ref()?;
                let field = Some(c.d.blocked_by_field.as_str()).filter(|f| !f.is_empty())?;
                Some(format!("It has \"block\" in its name and is set on {} sprint items.", data.items.iter().filter(|i| i.field_text(field).is_some()).count()))
            }
            "goal" => {
                let data = c.data.as_ref()?;
                (!c.d.goal_tag.is_empty()).then(|| format!("The tag with \"goal\" in it used most in this sprint: on {} items.", data.items.iter().filter(|i| i.tags.contains(&c.d.goal_tag)).count()))
            }
            "added" => (!c.d.added_tags.is_empty()).then(|| "These tags say \"added\" or \"stretch\" and are used in this sprint.".to_owned()),
            "review" => Some("States with \"review\" in their name.".to_owned()),
            _ => None,
        }
    }

    /// The fields of the step.
    pub fn body(&self, c: &Ctx, setup: &Setup) -> Vec<Node> {
        let names = c.type_names.as_deref();
        match self.id {
            "where" => {
                let orgs: Vec<String> = setup.repos.iter().fold(Vec::new(), |mut orgs, r| {
                    if !orgs.contains(&r.org) {
                        orgs.push(r.org.clone());
                    }
                    orgs
                });
                let projects = c.projects.as_ref().and_then(|p| p.value.clone());
                let mut out = vec![
                    one(setup, "Organization", Text::Org, (!setup.repos.is_empty()).then_some(orgs.as_slice()), One { none: None, placeholder: Some("https://dev.azure.com/your-org"), labels: None }),
                    one(setup, "Project", Text::Project, projects.as_deref().map(Vec::as_slice), One { none: None, placeholder: None, labels: None }),
                ];
                out.extend(list_status(c.projects.as_ref(), "projects"));
                out
            }
            "team" => {
                let label = |t: &str| if c.m.as_ref().is_some_and(|m| m.my_teams.iter().any(|x| x == t)) { format!("{t} (yours)") } else { t.to_owned() };
                let mut out = vec![one(setup, "Team", Text::Team, c.m.as_ref().map(|m| m.teams.as_slice()), One { none: None, placeholder: None, labels: Some(&label) })];
                out.extend(list_status(c.meta.as_ref(), "the project's teams"));
                out
            }
            "people" => {
                let mut hints = counted(c.data.iter().flat_map(|d| d.items.iter()).filter_map(|i| i.assignee.as_deref()).filter(|a| !a.is_empty()));
                for m in c.members.as_ref().and_then(|m| m.value.clone()).iter().flat_map(|m| m.iter()) {
                    if !hints.iter().any(|(n, _)| *n == m.name) {
                        hints.push((m.name.clone(), 0));
                    }
                }
                hints.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase())));
                let users = c.org_ok.then(|| super::lists::org_users().want(c.org.clone()));
                let suggest: Option<Rc<Vec<Person>>> = users.as_ref().and_then(|u| u.value.clone());
                let options: Vec<String> = hints.iter().map(|(n, _)| n.clone()).collect();
                let labels = sprint_count_labels(&hints);
                let extra = if suggest.is_some() { "Search everyone by name or email" } else { "Add a display name, then Enter" };
                let mut out = vec![many(setup, Many::Members, Some(&options), Many_ { labels: Some(&labels), extra: Some(extra), suggest })];
                out.extend(list_status(c.sprint.as_ref(), "the sprint's people"));
                out.extend(list_status(users.as_ref(), "the organization's people"));
                out
            }
            "stories" => vec![
                field_group("Stories are", many(setup, Many::StoryTypes, names, plain()), None),
                field_group("Tasks under a story are", many(setup, Many::ChildTypes, names, plain()), None),
                field_group("A story is your team's when it has a task of type", many(setup, Many::ScopeChildTypes, names, plain()), Some("None picked means every story is your team's.")),
            ],
            "other" => vec![
                field_group("Types", many(setup, Many::ItemTypes, names, plain()), None),
                field_group("Title prefixes", many(setup, Many::TitlePrefixes, Some(&[]), Many_ { labels: None, extra: Some("Add a prefix, then Enter"), suggest: None }), None),
            ],
            "blocked" => {
                let fields: Option<Vec<String>> = c.m.as_ref().map(|m| {
                    let mut fields: Vec<&super::lists::FieldInfo> = m.fields.iter().filter(|f| ["string", "plainText"].contains(&f.kind.as_str())).collect();
                    let blocks = |f: &super::lists::FieldInfo| format!("{} {}", f.reference, f.name).to_lowercase().contains("block");
                    fields.sort_by(|a, b| (!blocks(a)).cmp(&!blocks(b)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
                    fields.iter().map(|f| f.reference.clone()).collect()
                });
                let label = |reference: &str| format!("{} ({reference})", c.m.as_ref().and_then(|m| m.field(reference)).map_or(reference, |f| f.name.as_str()));
                vec![one(setup, "Field", Text::BlockedByField, fields.as_deref(), One { none: Some("None (checks off)"), placeholder: Some("Custom.Blocker"), labels: Some(&label) })]
            }
            "goal" => {
                let counts = counted(c.data.iter().flat_map(|d| d.items.iter()).flat_map(|i| i.tags.iter().map(String::as_str)));
                let tags: Option<Vec<String>> = c.m.as_ref().map(|m| counts.iter().map(|(t, _)| t.clone()).chain(m.tags.iter().filter(|t| !counts.iter().any(|(n, _)| n == *t)).cloned()).collect());
                let labels = sprint_count_labels(&counts);
                vec![one(setup, "Tag", Text::GoalTag, tags.as_deref(), One { none: Some("None (test off)"), placeholder: None, labels: Some(&labels) })]
            }
            "added" => {
                let counts = counted(c.data.iter().flat_map(|d| d.items.iter()).flat_map(|i| i.tags.iter().map(String::as_str)));
                let tags: Vec<String> = counts.iter().map(|(t, _)| t.clone()).collect();
                let numbers: Option<Vec<String>> = c.m.as_ref().map(|m| {
                    let mut n: Vec<String> = m.fields.iter().filter(|f| ["integer", "double"].contains(&f.kind.as_str()) && (f.reference.starts_with("Custom.") || f.reference.starts_with("Microsoft.VSTS.Scheduling."))).map(|f| f.reference.clone()).collect();
                    n.sort();
                    n
                });
                let tag_labels = |t: &str| format!("{t} · {} in sprint", counts.iter().find(|(n, _)| n == t).map_or(0, |(_, n)| *n));
                let field_labels = |reference: &str| c.m.as_ref().and_then(|m| m.field(reference)).map_or(reference.to_owned(), |f| f.name.clone());
                vec![
                    field_group("Tags", many(setup, Many::AddedTags, Some(&tags), Many_ { labels: Some(&tag_labels), extra: Some("Add a tag, then Enter"), suggest: None }), None),
                    field_group("Types that need points", many(setup, Many::PointTypes, names, plain()), None),
                    field_group("Point fields", many(setup, Many::PointFields, numbers.as_deref(), Many_ { labels: Some(&field_labels), extra: None, suggest: None }), None),
                ]
            }
            "review" => {
                let chosen: Vec<&String> = c.d.story_types.iter().chain(&c.d.child_types).chain(&c.d.item_types).collect();
                let states: Option<Vec<String>> = c.m.as_ref().map(|m| {
                    let mut states: Vec<String> = Vec::new();
                    for t in m.types.iter().filter(|t| chosen.contains(&&t.name)) {
                        for s in &t.states {
                            if !states.contains(&s.name) {
                                states.push(s.name.clone());
                            }
                        }
                    }
                    states
                });
                let parked = setup.draft.as_ref().map_or("", |d| d.s.parked_pr_prefix.as_str());
                vec![
                    field_group("States", many(setup, Many::CodeReviewStates, states.as_deref(), plain()), None),
                    field("Skip pull requests titled", text_field("Skip pull requests titled", "parked", parked, Some("Leave empty to check them all"), |v| edit(|d| d.parked_pr_prefix = v)), Some("A pull request whose title starts with this is parked on purpose.")),
                ]
            }
            "stale" => {
                let value = setup.draft.as_ref().map_or(String::new(), |d| d.stale_text.clone().unwrap_or_else(|| d.s.stale_days.to_string()));
                vec![field(
                    "Working days",
                    text_field("Working days", "stale", &value, None, |v| {
                        crate::sidebar::with(|s| {
                            if let Some(d) = &mut s.setup.draft {
                                d.stale_text = Some(v);
                            }
                        });
                        settle();
                    }),
                    None,
                )]
            }
            _ => Vec::new(),
        }
    }

    /// A live preview from the real sprint of what the answer does.
    pub fn show(&self, c: &Ctx, setup: &Setup) -> Option<Node> {
        let d = &c.d;
        match self.id {
            "where" => (!setup.repos.is_empty()).then(|| {
                preview(
                    "Azure DevOps repos open in Wings",
                    setup
                        .repos
                        .iter()
                        .take(4)
                        .enumerate()
                        .map(|(n, r)| {
                            gap(row(), "s").key(n.to_string()).child(text(format!("{} · {}", r.project, r.org.replace("https://dev.azure.com/", ""))).prop("size", "small").prop("truncate", true).prop("grow", true)).child(badge(format!("{} pane{}", r.panes, if r.panes > 1 { "s" } else { "" }), None))
                        })
                        .collect(),
                )
            }),
            "team" => {
                let Some(data) = &c.data else { return wait_for(c) };
                let cats = counted(data.items.iter().map(|i| Some(category_of(c, i)).filter(|c| !c.is_empty()).unwrap_or_else(|| "Other".to_owned())).collect::<Vec<_>>().iter().map(String::as_str));
                let legend = gap(row(), "m").prop("wrap", true).children(cats.iter().map(|(cat, n)| {
                    let (tone, name) = match cat.as_str() {
                        "Proposed" => (Some("muted"), "Not started"),
                        "InProgress" => (Some("info"), "In progress"),
                        "Resolved" => (Some("warn"), "Resolved"),
                        "Completed" => (Some("success"), "Done"),
                        other => (None, other),
                    };
                    let dot = match tone {
                        Some(tone) => Node::new("Dot").prop("tone", tone),
                        None => Node::new("Dot"),
                    };
                    gap(row(), "s").key(cat.as_str()).child(dot).child(muted(format!("{name} {n}")).prop("size", "tiny"))
                }));
                Some(preview(&format!("{} · {} items", data.sprint.name, data.items.len()), vec![legend]))
            }
            "people" => {
                let Some(_) = &c.data else { return wait_for(c) };
                let items = people_items(c);
                let mut body = shown_rows(c, &items, 4, |i| vec![badge(i.state.as_str(), None).key("state")]);
                if items.len() > 4 {
                    body.push(muted_small(format!("+ {} more", items.len() - 4)).key("more"));
                }
                Some(preview(&format!("Their work in this sprint · {}", items.len()), body))
            }
            "stories" => {
                let Some(data) = &c.data else { return wait_for(c) };
                let stories: Vec<&SprintItem> = data.items.iter().filter(|i| d.story_types.contains(&i.kind)).collect();
                let kids_of = |id: u64| data.items.iter().filter(move |i| i.parent == Some(id));
                let mine = |s: &SprintItem| d.scope_child_types.is_empty() || kids_of(s.id).any(|k| d.scope_child_types.contains(&k.kind));
                let story = stories.iter().find(|s| mine(s) && kids_of(s.id).next().is_some()).or_else(|| stories.iter().find(|s| kids_of(s.id).next().is_some()));
                let Some(story) = story else { return Some(preview("A story and its tasks", vec![no_example()])) };
                let mut body = vec![preview_row(c, story, vec![if mine(story) { badge("Yours", Some("success")) } else { badge("Not yours", None) }.key("mine")])];
                body.extend(kids_of(story.id).take(5).map(|k| {
                    let checked = d.child_types.contains(&k.kind);
                    gap(row(), "none").key(format!("child{}", k.id)).child(em_space()).child(preview_row(c, k, if checked { vec![badge("checked", None).key("checked")] } else { vec![] }))
                }));
                Some(preview(if mine(story) { "Your team's story, with its tasks" } else { "A story that isn't your team's" }, body))
            }
            "other" => {
                let Some(data) = &c.data else { return wait_for(c) };
                let items: Vec<&SprintItem> = data
                    .items
                    .iter()
                    .filter(|i| d.item_types.contains(&i.kind) && (i.assignee.as_ref().is_some_and(|a| d.members.contains(a)) || d.title_prefixes.iter().any(|p| i.title.to_lowercase().starts_with(&p.to_lowercase()))))
                    .collect();
                Some(preview(&format!("Included now · {}", items.len()), shown_rows(c, &items, 4, |_| vec![])))
            }
            "blocked" => {
                let Some(data) = &c.data else { return wait_for(c) };
                let field = d.blocked_by_field.as_str();
                if field.is_empty() {
                    return Some(preview("Blocked marks are off", vec![]));
                }
                let set: Vec<&SprintItem> = data.items.iter().filter(|i| i.field_text(field).is_some()).collect();
                let starts_with_ticket = |t: &str| t.trim_start().trim_start_matches('#').starts_with(|c: char| c.is_ascii_digit());
                let Some(example) = set.iter().find(|i| !starts_with_ticket(&i.field_text(field).unwrap_or_default())).or(set.first()) else { return Some(preview("An item marked blocked", vec![no_example()])) };
                let value = example.field_text(field).unwrap_or_default();
                Some(preview(
                    "An item marked blocked",
                    vec![
                        preview_row(c, example, vec![badge("Blocked", Some("danger")).key("blocked")]),
                        text(format!("{}: \"{value}\"", field.rsplit('.').next().unwrap_or(field))).prop("size", "small").key("value"),
                        muted_small(if starts_with_ticket(&value) { "Starts with a ticket number, so it links to that item." } else { "Not a ticket number, so the checks propose putting the blocking ticket's number first." }).key("says"),
                    ],
                ))
            }
            "goal" => {
                let Some(data) = &c.data else { return wait_for(c) };
                if d.goal_tag.is_empty() {
                    return Some(preview("The lower-priority test is off", vec![]));
                }
                let items: Vec<&SprintItem> = data.items.iter().filter(|i| i.tags.contains(&d.goal_tag)).collect();
                Some(preview(&format!("Goal work · {}", items.len()), shown_rows(c, &items, 3, |_| vec![badge("Goal", Some("success")).key("goal")])))
            }
            "added" => {
                let Some(data) = &c.data else { return wait_for(c) };
                let start = data.sprint.start.as_deref().and_then(parse_time);
                let added: Vec<&SprintItem> = data.items.iter().filter(|i| start.is_some_and(|s| parse_time(&i.created).is_some_and(|c| c > s))).collect();
                let tags = &d.added_tags;
                Some(preview(
                    &format!("Created after the sprint started · {}", added.len()),
                    shown_rows(c, &added, 4, |i| {
                        if tags.is_empty() {
                            vec![]
                        } else if tags.iter().all(|t| i.tags.contains(t)) {
                            vec![badge("tagged", Some("success")).key("tag")]
                        } else {
                            vec![badge("missing tag", Some("warn")).key("tag")]
                        }
                    }),
                ))
            }
            "review" => {
                let Some(kind) = c.m.as_ref().and_then(|m| m.types.iter().find(|t| d.story_types.contains(&t.name))) else { return wait_for(c) };
                let review = &d.code_review_states;
                let flow: Vec<_> = kind.states.iter().filter(|s| s.category != "Removed").collect();
                let at = flow.iter().position(|s| review.contains(&s.name));
                let example = c.data.as_ref().and_then(|data| data.items.iter().find(|i| review.contains(&i.state)));
                let steps = gap(stack(), "xs").children(flow.iter().enumerate().map(|(n, s)| {
                    gap(stack(), "s").key(n.to_string()).child(text(s.name.as_str()).prop("size", "small")).maybe((Some(n) == at).then(|| {
                        gap(row(), "s")
                            .child(text(example.map_or("An item here".to_owned(), |e| format!("{} {}", e.id, e.title))).prop("truncate", true).prop("grow", true))
                            .child(badge("PR open?", Some("info")))
                    }))
                }));
                let mut body = vec![steps];
                if at.is_none() {
                    body.push(muted_small("No review state picked for this type.").key("none"));
                }
                Some(preview(&format!("{} workflow", kind.name), body))
            }
            "stale" => {
                let Some(data) = &c.data else { return wait_for(c) };
                let typed = setup.draft.as_ref().and_then(|d| d.stale_text.as_deref().map(|t| t.trim().parse::<f64>().ok().filter(|n| *n != 0.0 && n.is_finite()).unwrap_or(3.0)));
                let days = typed.unwrap_or(f64::from(d.stale_days)).max(1.0);
                let active: Vec<&SprintItem> = data.items.iter().filter(|i| matches!(category_of(c, i).as_str(), "InProgress" | "Resolved")).collect();
                let stale: Vec<&SprintItem> = active.iter().filter(|i| f64::from(working_days_ago(&i.changed)) >= days).copied().collect();
                let body = if stale.is_empty() {
                    vec![muted_small("Nothing in progress has gone that long without a change.").key("none")]
                } else {
                    stale.iter().take(4).map(|i| preview_row(c, i, vec![badge(format!("{}d", working_days_ago(&i.changed)), Some("warn")).key("days")])).collect()
                };
                Some(preview(&format!("Stale now · {} of {} in progress", stale.len(), active.len()), body))
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_steps_are_the_ten_the_readme_lists_and_only_the_checks_that_can_be_off_say_so() {
        assert_eq!(STEPS.iter().map(|s| s.id).collect::<Vec<_>>(), ["where", "team", "people", "stories", "other", "blocked", "goal", "added", "review", "stale"]);
        assert_eq!(STEPS.iter().filter(|s| s.optional).map(|s| s.id).collect::<Vec<_>>(), ["other", "blocked", "goal", "added", "review"]);
        let mut d = Settings { goal_tag: "goal".into(), blocked_by_field: "Custom.B".into(), added_tags: vec!["a".into()], point_types: vec!["Story".into()], code_review_states: vec!["Review".into()], ..Settings::default() };
        for step in STEPS.iter().filter(|s| s.optional) {
            step.off(&mut d);
        }
        assert_eq!((d.goal_tag.as_str(), d.blocked_by_field.as_str(), d.added_tags.len(), d.point_types.len(), d.code_review_states.len(), d.item_types.len(), d.title_prefixes.len()), ("", "", 0, 0, 0, 0, 0));
    }
}
