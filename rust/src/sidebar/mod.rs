//! The Sprint board sidebar. Main reads the board and keeps its state and board in storage; this page picks the view and
//! runs the az sign-in. `setup.rs` detects and edits the settings, the board views draw the board and an item.
//! Everything read from Azure DevOps is untrusted, so it only ever goes into the page as text.

mod board_view;
mod checks_view;
mod detail_view;
mod items;
mod kit;
mod lists;
mod pickers;
mod rich;
mod settings_view;
mod setup;
mod steps;
mod time;

use crate::{
    az::line_of,
    check::{BoardItem, Snapshot},
    state::{self, Phase, Published},
};
use items::{Detail, Outside};
use kit::{card_of, error_line, reading, strong};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use setup::Setup;
use std::{cell::RefCell, collections::HashMap};
use wings_plugin::{
    host, messages,
    settings::Setting,
    task::spawn,
    ui::{self, Node, muted, row},
};

/// The filters, tab and folds, remembered between starts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct View {
    pub tab: String,
    pub who: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub q: String,
    pub sprint: String,
    /// The groups and parents flipped from their default.
    pub toggled: Vec<String>,
}

impl Default for View {
    fn default() -> Self {
        Self { tab: "board".into(), who: "all".into(), kind: String::new(), q: String::new(), sprint: String::new(), toggled: Vec::new() }
    }
}

fn saved_view() -> Setting<View> {
    Setting::new("view", View::default(), |stored| serde_json::from_value(stored.clone()).ok(), |view| serde_json::to_value(view).unwrap_or(Value::Null))
}

pub struct Sidebar {
    /// What main served last.
    pub main: Option<Published>,
    /// The board of the last check, which main keeps in storage.
    pub snapshot: Option<Snapshot>,
    pub view: View,
    /// Items opened, the last one on screen.
    pub opened: Vec<u64>,
    /// The signed-in az account, lowercased, to filter "Mine"; empty when it couldn't be read.
    pub me_login: Option<String>,
    pub details: HashMap<u64, Detail>,
    pub outside: Outside,
    pub signing_in: bool,
    pub local_error: Option<String>,
    pub setup: Setup,
    /// Goes up with each change of the view, so only the last one is saved.
    saves: u64,
}

thread_local! {
    static SIDEBAR: RefCell<Sidebar> = RefCell::new(Sidebar {
        main: None,
        snapshot: None,
        view: View::default(),
        opened: Vec::new(),
        me_login: None,
        details: HashMap::new(),
        outside: Outside::default(),
        signing_in: false,
        local_error: None,
        setup: Setup::default(),
        saves: 0,
    });
}

pub fn with<T>(change: impl FnOnce(&mut Sidebar) -> T) -> T {
    SIDEBAR.with(|sidebar| change(&mut sidebar.borrow_mut()))
}

impl Sidebar {
    pub fn settings(&self) -> crate::settings::Settings {
        self.main.as_ref().map(|m| m.settings.clone()).unwrap_or_default()
    }

    pub fn by_id(&self, id: u64) -> Option<&BoardItem> {
        self.snapshot.as_ref()?.items.iter().find(|i| i.id == id)
    }

    pub fn type_color(&self, kind: &str) -> &str {
        self.snapshot.as_ref().and_then(|s| s.types.get(kind)).map_or("#888888", |t| &t.color)
    }

    pub fn state_color(&self, kind: &str, state: &str) -> Option<&str> {
        self.snapshot.as_ref()?.types.get(kind)?.states.iter().find(|s| s.name == state).map(|s| s.color.as_str())
    }

    pub fn work_item_url(&self, id: u64) -> String {
        let s = self.settings();
        crate::settings::item_url(&s.org, &s.project, id)
    }
}

/// Whether a group or parent is open: groups of done work and parents start closed.
pub fn is_open(view: &View, key: &str, open_by_default: bool) -> bool {
    open_by_default != view.toggled.iter().any(|k| k == key)
}

pub fn toggle(key: &str) {
    with(|s| {
        match s.view.toggled.iter().position(|k| k == key) {
            Some(at) => drop(s.view.toggled.remove(at)),
            None => s.view.toggled.push(key.to_owned()),
        }
    });
    save_view();
}

/// Saves the view a moment after the last change.
pub fn save_view() {
    let number = with(|s| {
        s.saves += 1;
        s.saves
    });
    spawn(async move {
        host::sleep(400).await;
        let view = with(|s| (s.saves == number).then(|| s.view.clone()));
        if let Some(view) = view {
            drop(saved_view().set(view));
        }
    });
}

/// Reads what main keeps, once on start and when it says it changed.
fn reload() {
    with(|s| {
        s.main = state::published().get();
        s.snapshot = state::board().get();
    });
    items::drop_stale_details();
    setup::maybe_detect();
}

async fn sign_in() {
    with(|s| s.signing_in = true);
    let outcome = crate::az::cli().sign_in(None).await;
    // az opens the browser itself.
    let failed = with(|s| {
        s.signing_in = false;
        s.local_error = outcome.err().map(|e| line_of(&e));
        s.local_error.is_some()
    });
    if failed {
        return;
    }
    if with(|s| s.main.as_ref().is_some_and(|m| m.phase == Phase::Setup)) {
        setup::detect().await;
    } else {
        messages::tell(state::REFRESH, &Value::Null);
    }
}

/// Reads what's missing again, in setup or on the board.
fn try_again() {
    if with(|s| s.main.as_ref().is_some_and(|m| m.phase == Phase::Setup)) {
        spawn(setup::detect());
    } else {
        messages::tell(state::REFRESH, &Value::Null);
    }
}

fn sign_in_card(s: &Sidebar) -> Node {
    let signing = s.signing_in;
    card_of(vec![
        strong("Sign in to Azure DevOps"),
        muted("The board is read with the az command line, which isn't signed in. Signing in opens your browser."),
        row()
            .child(ui::button(if signing { "Finish in your browser…" } else { "Sign in" }, "default", signing, || spawn(sign_in())))
            .child(ui::button("Try again", "ghost", false, try_again)),
    ])
    .key("sign-in")
}

fn refresh_button(running: bool) -> Node {
    ui::button(if running { "Checking…" } else { "Refresh" }, "ghost", running, || messages::tell(state::REFRESH, &Value::Null))
}

/// What the sidebar shows, in the order the page picks it.
#[derive(PartialEq)]
enum Screen {
    Reading,
    Detecting,
    Settings,
    SignIn,
    Failed,
    Board,
}

fn screen(s: &Sidebar) -> Screen {
    let Some(m) = &s.main else { return Screen::Reading };
    // The last check's board shows while the first check after a start runs.
    let stored = s.snapshot.is_some() && !m.settings.org.is_empty() && !matches!(m.phase, Phase::Setup | Phase::SignedOut);
    if !stored && (m.phase == Phase::Loading || (m.phase != Phase::Setup && m.running && m.result.is_none())) {
        Screen::Reading
    } else if s.setup.detecting.is_some() || (m.phase == Phase::Setup && s.setup.draft.is_none()) {
        Screen::Detecting
    } else if m.phase == Phase::Setup || s.setup.draft.is_some() {
        Screen::Settings
    } else if m.phase == Phase::SignedOut {
        Screen::SignIn
    } else if m.phase == Phase::Error && !stored {
        Screen::Failed
    } else {
        Screen::Board
    }
}

/// What the sidebar shows.
fn build(s: &Sidebar) -> Vec<Node> {
    let mut parts = Vec::new();
    let running = s.main.as_ref().is_some_and(|m| m.running);
    match screen(s) {
        Screen::Reading => parts.push(reading("Reading the sprint board…").key("reading")),
        Screen::Detecting => parts.push(settings_view::detecting(s)),
        Screen::Settings => {
            parts.push(settings_view::settings(s));
            if s.setup.detect_error.as_deref().is_some_and(|e| e.contains("signed in")) {
                parts.push(sign_in_card(s));
            }
        }
        Screen::SignIn => parts.push(sign_in_card(s)),
        Screen::Failed => parts.push(
            card_of(vec![
                strong("Couldn't read the board"),
                error_line(s.main.as_ref().and_then(|m| m.error.clone()).unwrap_or_else(|| "Unknown error".to_owned())),
                row().child(refresh_button(running)).child(ui::button("Settings", "ghost", false, setup::open_settings)),
            ])
            .key("error"),
        ),
        Screen::Board => parts.extend(board_view::main_view(s)),
    }
    if let Some(error) = s.local_error.as_deref().filter(|_| s.setup.draft.is_none()) {
        parts.push(error_line(error).key("local-error"));
    }
    parts
}

fn view() -> Vec<Node> {
    // What the page asks for as it is drawn: a search outside the sprint starts here, as it asks.
    with(|s| {
        if screen(s) == Screen::Board && s.opened.is_empty() && s.view.tab != "checks" {
            board_view::search_effects(s);
        }
    });
    SIDEBAR.with(|sidebar| build(&sidebar.borrow()))
}

#[unsafe(no_mangle)]
pub fn start() {
    wings_plugin::run(view);
    with(|s| s.view = saved_view().get());
    reload();
    state::published().on_change(|_| reload());
    state::board().on_change(|_| reload());
    // The panes say where Azure DevOps repos are open, for the setup steps.
    host::on_panes(setup::on_panes);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{check::Sprint, settings::Settings};

    fn published(phase: Phase, running: bool) -> Published {
        Published { phase, settings: Settings { org: "https://dev.azure.com/acme".into(), ..Settings::default() }, missing: Vec::new(), result: None, error: None, running }
    }

    fn board() -> Snapshot {
        Snapshot { checked_at: String::new(), sprint: Sprint { name: "S".into(), path: String::new(), start: None, finish: None }, items: Vec::new(), types: Default::default() }
    }

    fn screen_of(main: Option<Published>, snapshot: Option<Snapshot>, draft: bool, detecting: bool) -> Screen {
        with(|s| {
            s.main = main;
            s.snapshot = snapshot;
            s.setup.draft = draft.then(|| setup::Draft { s: Settings::default(), stale_text: None });
            s.setup.detecting = detecting.then(|| "Reading".to_owned());
            screen(s)
        })
    }

    #[test]
    fn the_sidebar_shows_what_main_says_and_the_last_board_while_the_first_check_runs() {
        assert!(screen_of(None, None, false, false) == Screen::Reading);
        assert!(screen_of(Some(published(Phase::Loading, true)), None, false, false) == Screen::Reading);
        assert!(screen_of(Some(published(Phase::Loading, true)), Some(board()), false, false) == Screen::Board);
        assert!(screen_of(Some(published(Phase::Ready, false)), Some(board()), false, false) == Screen::Board);
        assert!(screen_of(Some(published(Phase::Error, false)), None, false, false) == Screen::Failed);
        assert!(screen_of(Some(published(Phase::Error, false)), Some(board()), false, false) == Screen::Board);
        assert!(screen_of(Some(published(Phase::SignedOut, false)), Some(board()), false, false) == Screen::SignIn);
    }

    #[test]
    fn a_board_that_is_not_set_up_detects_then_shows_the_steps_and_settings_open_the_steps_over_a_board() {
        assert!(screen_of(Some(published(Phase::Setup, false)), Some(board()), false, false) == Screen::Detecting);
        assert!(screen_of(Some(published(Phase::Setup, false)), None, false, true) == Screen::Detecting);
        assert!(screen_of(Some(published(Phase::Setup, false)), None, true, false) == Screen::Settings);
        assert!(screen_of(Some(published(Phase::Ready, false)), Some(board()), true, false) == Screen::Settings);
    }

    #[test]
    fn the_view_is_saved_as_the_typescript_build_saved_it() {
        let view: View = serde_json::from_value(serde_json::json!({ "tab": "checks", "who": "p:Ada", "type": "Bug", "q": "x", "sprint": "none", "toggled": ["s:Active"] })).unwrap();
        assert_eq!((view.tab.as_str(), view.kind.as_str(), view.toggled.clone()), ("checks", "Bug", vec!["s:Active".to_owned()]));
        assert_eq!(serde_json::to_value(View::default()).unwrap(), serde_json::json!({ "tab": "board", "who": "all", "type": "", "q": "", "sprint": "", "toggled": [] }));
    }
}
