//! The settings form's fields: one value from a list, several values as checkboxes, and their labels.

use super::{
    kit::{field, gap, spinner},
    lists::{Loaded, Person},
    setup::{Many, Text, settle},
    with,
};
use serde_json::{Value, json};
use std::rc::Rc;
use wings_plugin::ui::{self, Choice, Combobox, Node, muted, row, stack, text};

/// What "Other…" is in a select, which no value is.
const OTHER: &str = "\u{0}other";

/// A list state as a line under a picker.
pub fn list_status<T>(state: Option<&Loaded<T>>, what: &str) -> Option<Node> {
    let state = state?;
    if state.loading {
        return Some(row().key(what).child(spinner()).child(muted(format!("Loading {what}…")).prop("size", "small")));
    }
    state.error.as_ref().map(|e| text(format!("Couldn't load {what}: {e}. Type it instead.")).prop("tone", "danger").prop("size", "small").key(what))
}

/// Changes the draft, if there is one.
pub fn edit(change: impl FnOnce(&mut crate::settings::Settings)) {
    with(|s| {
        if let Some(d) = &mut s.setup.draft {
            change(&mut d.s);
        }
    });
}

/// A text field showing a value of the form as it is now. Typing changes the form; the lists that depend on the value
/// load once typing stops.
pub fn text_field(label: &str, key: &'static str, value: &str, placeholder: Option<&str>, on_change: impl Fn(String) + 'static) -> Node {
    let input = ui::text_input(label, value, on_change).key(key);
    match placeholder {
        Some(p) => input.prop("placeholder", p),
        None => input,
    }
}

pub struct One<'a> {
    pub none: Option<&'a str>,
    pub placeholder: Option<&'a str>,
    pub labels: Option<&'a dyn Fn(&str) -> String>,
}

/// One value from a list, with "Other…" for typing one, under `label`. Falls back to a text field while the list
/// loads or fails.
pub fn pick_one(label: &str, key: Text, current: &str, options: Option<&[String]>, other: Option<&str>, o: One) -> Node {
    let name = key.name();
    let typed = move |value: String| {
        edit(|d| key.set(d, value.clone()));
        with(|s| drop(s.setup.other.insert(name, value)));
        settle();
    };
    let input = text_field(label, name, current, o.placeholder, typed);
    let Some(options) = options else { return field(label, input, None) };
    let is_other = other.is_some() || (!current.is_empty() && !options.iter().any(|v| v == current));
    // The typed value sits beside the field, not in it.
    let mut choices: Vec<Value> = Vec::new();
    match (o.none, current.is_empty() && !is_other) {
        (Some(none), _) => choices.push(json!({ "value": "", "label": none })),
        (None, true) => choices.push(json!({ "value": "", "label": "Choose…", "disabled": true })),
        (None, false) => {}
    }
    choices.extend(options.iter().map(|v| json!({ "value": v, "label": o.labels.map_or_else(|| v.clone(), |l| l(v)) })));
    choices.push(json!({ "value": OTHER, "label": "Other…" }));
    let current_owned = current.to_owned();
    let select = Node::new("Select").prop("label", "").prop("options", choices).prop("value", if is_other { OTHER } else { current }).on("onChange", move |event| {
        let value = event["value"].as_str().unwrap_or_default().to_owned();
        if value == OTHER {
            with(|s| drop(s.setup.other.insert(name, current_owned.clone())));
        } else {
            with(|s| drop(s.setup.other.remove(name)));
            edit(|d| key.set(d, value));
            with(|s| {
                if let Some(d) = s.setup.draft.clone() {
                    s.setup.settle_now(&d.s);
                }
            });
        }
    });
    gap(stack(), "s").key(label).child(field(label, select, None)).maybe(is_other.then(|| text_field(label, "text", current, o.placeholder, move |value: String| {
        edit(|d| key.set(d, value.clone()));
        with(|s| drop(s.setup.other.insert(name, value)));
        settle();
    })))
}

pub struct Many_<'a> {
    pub labels: Option<&'a dyn Fn(&str) -> String>,
    pub extra: Option<&'static str>,
    pub suggest: Option<Rc<Vec<Person>>>,
}

/// The people the field finds as you type: not ticked yet, by name or email, six at most.
pub fn suggestions(typed: &str, values: &[String], suggest: &[Person]) -> Vec<Person> {
    let q = typed.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    suggest.iter().filter(|p| !values.contains(&p.name) && (p.name.to_lowercase().contains(&q) || p.login.to_lowercase().contains(&q))).take(6).cloned().collect()
}

/// What a click on a value of a checkbox list does: ticked values come first and stay put, so what was ticked when the
/// form opened is kept the first time the list changes.
fn remember_ticked(key: Many) {
    with(|s| {
        let values = s.setup.draft.as_ref().map(|d| key.get(&d.s).iter().cloned().collect()).unwrap_or_default();
        s.setup.ticked_first.entry(key.name()).or_insert(values);
    });
}

/// Adds values to a list.
fn add_values(key: Many, added: Vec<String>) {
    remember_ticked(key);
    edit(|d| {
        let mut values = key.get(d).clone();
        values.extend(added.into_iter().filter(|v| !key.get(d).contains(v)));
        key.set(d, values);
    });
    with(|s| drop(s.setup.other.remove(key.name())));
}

/// Several values from a list as checkboxes, plus a field for values the list doesn't have. With `suggest`, the field
/// searches those people by name or email as you type.
pub fn pick_many(key: Many, values: &[String], options: Option<&[String]>, typed: &str, first: Option<&std::collections::HashSet<String>>, o: Many_) -> Node {
    let name = key.name();
    let ticked: std::collections::HashSet<String> = first.cloned().unwrap_or_else(|| if options.is_some() { values.iter().cloned().collect() } else { Default::default() });
    let mut listed: Vec<String> = options.map_or_else(Vec::new, <[String]>::to_vec);
    listed.sort_by_key(|v| std::cmp::Reverse(ticked.contains(v)));
    let extras: Vec<String> = values.iter().filter(|v| !listed.contains(v)).cloned().collect();
    let boxes = listed.iter().chain(&extras).map(|v| {
        let (value, on) = (v.clone(), values.to_vec());
        ui::checkbox(o.labels.map_or_else(|| v.clone(), |l| l(v)), values.contains(v), move |checked| {
            remember_ticked(key);
            let mut next: Vec<String> = on.iter().filter(|x| **x != value).cloned().collect();
            if checked {
                next.push(value.clone());
            }
            edit(|d| key.set(d, next));
        })
        .key(v.clone())
    });
    let found = o.suggest.as_deref().map_or_else(Vec::new, |people| suggestions(typed, values, people));
    let add_typed = move || {
        let typed = with(|s| s.setup.other.get(name).cloned().unwrap_or_default());
        add_values(key, typed.split(',').map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned).collect());
    };
    let on_type = move |text: String| with(|s| drop(s.setup.other.insert(name, text)));
    let add = if o.suggest.is_some() {
        let people = found.clone();
        ui::combobox(
            Combobox {
                label: "",
                placeholder: "Search everyone by name or email",
                value: typed.to_owned(),
                query: None,
                options: found.iter().map(|p| Choice { value: p.name.clone(), label: p.name.clone(), detail: Some(p.login.clone()) }).collect(),
                empty: "",
                auto_focus: false,
            },
            move |text| on_type(text.unwrap_or_default()),
            move |picked| {
                let name = people.iter().find(|p| p.name == picked).map_or_else(|| picked.to_owned(), |p| p.name.clone());
                add_values(key, vec![name]);
            },
        )
    } else {
        let enter = add_typed;
        ui::text_input("", typed, on_type)
            .key("add")
            .prop("placeholder", o.extra.unwrap_or("Add another, then Enter"))
            .on("onKeyDown", move |event| {
                if event["key"] == "Enter" {
                    enter();
                }
            })
    };
    gap(stack(), "s").key(name).maybe((!listed.is_empty() || !extras.is_empty()).then(|| gap(stack(), "xs").children(boxes))).child(add)
}
