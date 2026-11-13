//! The setup stepper: Back/Next, Turn this check off, Use detected for the rest, and dots to jump to a step.

use super::{
    Sidebar,
    kit::{card_of, error_line, gap, muted_small, reading, small_button, strong, title_large},
    pickers::edit,
    setup::{self, context, save},
    steps::STEPS,
    with,
};
use crate::state::Phase;
use wings_plugin::{
    task::spawn,
    ui::{self, Node, row, stack, text},
};

/// Moves to a step.
fn go_to(n: usize) {
    with(|s| s.setup.step = n.min(STEPS.len() - 1));
}

fn close() {
    with(|s| {
        s.setup.draft = None;
        s.setup.detection = None;
        s.local_error = None;
    });
}

pub fn settings(s: &Sidebar) -> Node {
    let setup = &s.setup;
    let c = context(setup);
    let step = setup.step.min(STEPS.len() - 1);
    let st = &STEPS[step];
    let in_setup = s.main.as_ref().is_some_and(|m| m.phase == Phase::Setup);
    let essentials = STEPS[..3].iter().all(|x| x.ready(&c));
    let ready = st.ready(&c);
    let last = step == STEPS.len() - 1;
    let next = move || {
        if ready {
            if last { spawn(save()) } else { go_to(step + 1) }
        }
    };

    let dots = gap(row(), "xs").prop("wrap", true).children(STEPS.iter().enumerate().map(|(n, x)| {
        Node::new("Button")
            .key(x.id)
            .prop("chip", true)
            .prop("pressed", n == step)
            // Later steps need the board picked first.
            .prop("disabled", n > step && !essentials)
            .prop("label", format!("Step {}: {}", n + 1, x.question))
            .on("onClick", move |_| go_to(n))
            .text((n + 1).to_string())
    }));
    let detected = setup.detection.as_ref().filter(|_| step == 0).map(|d| {
        let notes = d.notes.iter().enumerate().map(|(i, n)| text(n.as_str()).prop("size", "small").key(format!("n{i}")));
        let off = d.off.iter().enumerate().map(|(i, n)| muted_small(format!("Off: {n}")).key(format!("o{i}")));
        ui::disclosure(format!("What was detected ({} calls, {:.1} s)", d.calls, d.ms / 1000.0), gap(stack(), "xs").children(notes).children(off)).key("detected")
    });

    let mut content = vec![
        row()
            .key("head")
            .child(muted_small(format!("{} · step {} of {}", if in_setup { "Set up" } else { "Settings" }, step + 1, STEPS.len())).prop("grow", true))
            .maybe((!in_setup).then(|| small_button("Close", "ghost", "sm", false, close))),
        dots.key("dots"),
        title_large(st.question).key("question"),
        text(st.explain).prop("tone", "muted").key("explain"),
    ];
    content.extend(st.why(&c, setup).map(|why| text(why).prop("tone", "info").prop("size", "small").key("why")));
    content.extend(setup.detect_error.as_ref().filter(|_| step == 0).map(|e| error_line(format!("Couldn't detect the settings: {e}")).key("detect-error")));
    content.extend(detected);
    content.extend(st.body(&c, setup));
    content.extend(st.show(&c, setup));
    content.extend(s.local_error.as_ref().map(|e| error_line(e.as_str()).key("local-error")));
    let next_label = if !last { "Next" } else if in_setup { "Finish" } else { "Save" };
    content.push(
        row()
            .key("buttons")
            .maybe((step > 0).then(|| ui::button("Back", "ghost", false, move || go_to(step - 1))))
            .child(text("").prop("grow", true))
            .maybe(st.optional.then(|| {
                ui::button("Turn this check off", "ghost", false, move || {
                    edit(|d| STEPS[step].off(d));
                    if last { spawn(save()) } else { go_to(step + 1) }
                })
            }))
            .child(ui::button(next_label, "default", false, next).prop("disabled", !ready)),
    );
    content.push(
        row()
            .key("more")
            .prop("justify", "end")
            .child(small_button("Detect again", "ghost", "sm", setup.detecting.is_some(), || spawn(setup::detect())))
            .maybe((essentials && !last).then(|| small_button(if in_setup { "Use detected for the rest" } else { "Save now" }, "ghost", "sm", false, || spawn(save())))),
    );
    card_of(content).key("settings")
}

pub fn detecting(s: &Sidebar) -> Node {
    card_of(vec![strong("Setting up your sprint board"), reading(s.setup.detecting.as_deref().unwrap_or_default())]).key("detecting")
}
