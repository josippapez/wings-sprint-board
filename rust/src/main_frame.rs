//! The main script: reads the board in the background, keeps the state of the check for the sidebar, sets the title bar
//! label and answers Claude's `board_check` tool.

use crate::{
    az::Failure,
    check::{Checked, as_text, board_check},
    settings::{self, Settings},
    state::{self, Phase, Published},
};
use serde_json::{Value, json};
use std::cell::RefCell;
use wings_plugin::{
    cache::Cached,
    format::plural,
    host, messages, poll,
    task::spawn,
    tools,
};

const SIDEBAR: &str = "board";
const POLL_MS: u32 = 15 * 60_000;
/// A full check runs from a handful to a few dozen az calls, and a board changes slowly. A check from the last minute
/// is fresh enough for Claude.
const FRESH_MS: f64 = 60_000.0;

struct Main {
    phase: Phase,
    settings: Settings,
    missing: Vec<String>,
    result: Option<Checked>,
    error: Option<String>,
    running: bool,
    /// When the last check ended, and whether it got a board.
    ended: Option<(f64, bool)>,
    /// The label last sent, so the same one isn't sent again.
    label: String,
}

thread_local! {
    static MAIN: RefCell<Main> = RefCell::new(Main {
        phase: Phase::Loading,
        settings: Settings::default(),
        missing: Vec::new(),
        result: None,
        error: None,
        running: false,
        ended: None,
        label: String::new(),
    });
    /// One check at a time: asking while one runs joins it.
    static CHECKS: Cached<(), ()> = Cached::new(0.0, 0.0, |()| async {
        run().await;
        Ok(())
    });
}

fn with<T>(change: impl FnOnce(&mut Main) -> T) -> T {
    MAIN.with(|main| change(&mut main.borrow_mut()))
}

fn publish() {
    let published = with(|m| Published { phase: m.phase, settings: m.settings.clone(), missing: m.missing.clone(), result: m.result.as_ref().map(|r| r.report.clone()), error: m.error.clone(), running: m.running });
    drop(state::published().set(Some(published)));
}

/// The text by the title bar button: what the board looks like at a glance, with the board checks and each person as rows.
fn label() {
    let (text, rows, tone) = with(|m| {
        if m.phase == Phase::SignedOut {
            return (Some("Sign in".to_owned()), Vec::new(), Some("warning"));
        }
        let (Phase::Ready, Some(r)) = (m.phase, &m.result) else { return (None, Vec::new(), None) };
        let items = &r.snapshot.items;
        let active = items.iter().filter(|i| matches!(i.category.as_str(), "InProgress" | "Resolved")).count();
        let blocked = items.iter().filter(|i| i.blocked && i.category != "Completed").count();
        let n = r.report.findings.len();
        let mut rows = vec![json!({ "label": "Sprint", "value": r.report.sprint.name }), json!({ "label": "Board checks", "value": if n > 0 { plural(n, "finding") } else { "Clean".to_owned() } })];
        for p in r.report.people.iter().take(4) {
            let blocked = p.items.iter().filter(|i| i.blocked).count();
            let escalate = if p.low_priority.as_ref().is_some_and(|l| l.meets) { ", escalate" } else { "" };
            rows.push(json!({ "label": p.name, "value": format!("{} open, {blocked} blocked{escalate}", p.items.len()) }));
        }
        (Some(format!("{active} in progress · {blocked} blocked")), rows, (blocked > 0).then_some("warning"))
    });
    let params = json!({ "sidebarId": SIDEBAR, "label": text, "rows": rows, "tone": tone });
    if with(|m| std::mem::replace(&mut m.label, params.to_string())) != params.to_string() {
        drop(host::call("setSidebarLabel", params));
    }
}

async fn run() {
    run_with(settings::saved().get()).await;
}

/// Reads the board once with these settings, and says how it went. Whether a board came of it is `ended`'s.
async fn run_with(settings: Settings) {
    let outcome: Result<bool, Failure> = async {
        let missing = settings::missing(&settings);
        with(|m| {
            m.missing = missing.clone();
            m.settings = settings.clone();
        });
        if !missing.is_empty() {
            with(|m| {
                m.phase = Phase::Setup;
                m.result = None;
                m.error = None;
            });
            return Ok(false);
        }
        with(|m| {
            m.running = true;
            // Still "setup" here would send the sidebar back into the stepper while the first check runs.
            if m.phase == Phase::Setup {
                m.phase = Phase::Loading;
            }
        });
        publish();
        let checked = board_check(&settings).await?;
        state::board().set(Some(checked.snapshot.clone()))?;
        with(|m| {
            m.phase = Phase::Ready;
            m.result = Some(checked);
            m.error = None;
        });
        Ok(true)
    }
    .await;
    with(|m| {
        m.running = false;
        m.ended = Some((host::now(), matches!(outcome, Ok(true))));
        if let Err(error) = outcome {
            m.error = Some(error.line());
            m.phase = if error.signed_out {
                Phase::SignedOut
            } else if m.result.is_some() {
                Phase::Ready
            } else {
                Phase::Error
            };
        }
    });
    publish();
    label();
}

/// Reads the board now, or joins the check that is running.
async fn refresh() {
    let _ = CHECKS.with(Cached::clone).get(()).await;
}

/// The board check as text, for Claude.
async fn board_text() -> Result<Value, String> {
    if with(|m| m.ended.is_none_or(|(at, _)| host::now() - at >= FRESH_MS)) {
        refresh().await;
    }
    with(|m| {
        if m.phase == Phase::Setup {
            return Err(format!("The sprint board isn't set up. Open its sidebar in Wings and fill in {}.", m.missing.join(", ")));
        }
        if m.phase == Phase::SignedOut {
            return Err("az isn't signed in. Open the Sprint board sidebar in Wings and sign in.".to_owned());
        }
        match (&m.result, m.ended) {
            (Some(r), Some((_, true))) => Ok(Value::String(as_text(&r.report))),
            _ => Err(m.error.clone().unwrap_or_else(|| "The board check failed.".to_owned())),
        }
    })
}

#[unsafe(no_mangle)]
pub fn start() {
    messages::on(state::REFRESH, |_| spawn(refresh()));
    settings::saved().on_change(|_| spawn(refresh()));
    tools::register("board_check", json!({ "type": "object", "properties": {}, "additionalProperties": false }), |_, _| board_text());
    spawn(refresh());
    poll::while_focused(POLL_MS, false, || spawn(refresh()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{answering, az, settings};
    use std::rc::Rc;
    use wings_plugin::task::block_on;

    /// Every call answered by `answer`, and the labels sent kept.
    fn labels(answer: impl Fn(&str, &Value) -> Result<Value, String> + 'static) -> Rc<RefCell<Vec<Value>>> {
        let sent = Rc::new(RefCell::new(Vec::new()));
        let seen = sent.clone();
        host::testing::answer(move |method, params| {
            if method == "setSidebarLabel" {
                seen.borrow_mut().push(params.clone());
                return Ok(Value::Null);
            }
            answer(method, params)
        });
        sent
    }

    #[test]
    fn a_board_that_isnt_set_up_is_the_setup_phase_and_tells_claude_what_to_fill_in() {
        host::testing::answer(|_, _| Ok(Value::Null));
        block_on(async { run_with(Settings::default()).await });
        with(|m| assert_eq!((m.phase, m.missing.clone()), (Phase::Setup, vec!["Organization".to_owned(), "Project".to_owned(), "Team".to_owned(), "Team members".to_owned()])));
        assert_eq!(
            block_on(async { board_text().await }),
            Err("The sprint board isn't set up. Open its sidebar in Wings and fill in Organization, Project, Team, Team members.".into())
        );
    }

    #[test]
    fn a_signed_out_az_is_the_signed_out_phase_and_the_label_asks_to_sign_in() {
        let sent = labels(|_, _| Ok(json!({ "code": 1, "stdout": "", "stderr": "ERROR: Please run 'az login' to setup account." })));
        block_on(async { run_with(settings()).await });
        with(|m| assert_eq!((m.phase, m.error.clone()), (Phase::SignedOut, Some("ERROR: Please run 'az login' to setup account.".to_owned()))));
        let first = sent.borrow()[0].clone();
        assert_eq!((first["label"].as_str(), first["tone"].as_str()), (Some("Sign in"), Some("warning")));
        label();
        assert_eq!(sent.borrow().len(), 1, "the same label isn't sent again");
        assert_eq!(block_on(async { board_text().await }), Err("az isn't signed in. Open the Sprint board sidebar in Wings and sign in.".into()));
    }

    #[test]
    fn a_checked_board_is_ready_with_a_label_of_what_is_going_on_and_claude_gets_its_text() {
        answering();
        let sent = labels(az);
        block_on(async { run_with(settings()).await });
        with(|m| assert_eq!((m.phase, m.running, m.error.clone()), (Phase::Ready, false, None)));
        let label = sent.borrow().last().unwrap().clone();
        assert_eq!(label["label"], "3 in progress · 0 blocked");
        assert!(label["tone"].is_null());
        assert_eq!(label["rows"][1], json!({ "label": "Board checks", "value": "8 findings" }));
        assert_eq!(label["rows"][2], json!({ "label": "Ada", "value": "3 open, 0 blocked" }));
        assert!(block_on(async { board_text().await }).unwrap().as_str().unwrap().contains("Findings (8):"));
    }

    #[test]
    fn a_failed_check_after_a_good_one_keeps_the_board_and_says_why() {
        answering();
        block_on(async { run_with(settings()).await });
        host::testing::answer(|_, _| Ok(json!({ "code": 1, "stdout": "", "stderr": "ERROR: boom" })));
        block_on(async { run_with(settings()).await });
        with(|m| assert_eq!((m.phase, m.result.is_some(), m.error.clone()), (Phase::Ready, true, Some("ERROR: boom".to_owned()))));
        assert_eq!(block_on(async { board_text().await }), Err("ERROR: boom".into()));
    }
}
