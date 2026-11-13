//! A made-up Azure DevOps for the tests, answered in place of `az`.

use crate::settings::Settings;
use serde_json::{Value, json};
use wings_plugin::{format::parse_time, host};

/// A made-up sprint in `acme/Web`: story 1 in review with no PR, its task 2 active with nobody on it, a closed
/// blocker 9 on story 3, and a pull request 77 that is completed on story 4 in review.
pub fn answering() {
    host::testing::set_now(parse_time("2026-11-13T12:00:00Z").unwrap());
    host::testing::answer(az);
}

/// What `az` and git print for the made-up board.
pub fn az(method: &str, params: &Value) -> Result<Value, String> {
    if method != "exec" {
        return Ok(Value::Null);
    }
    {
        let args: Vec<&str> = params["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
        let ok = |answer: Value| Ok(json!({ "code": 0, "stdout": answer.to_string(), "stderr": "" }));
        let row = |id: u64, kind: &str, state: &str, who: Option<&str>, parent: Option<u64>, blocker: &str| {
            let mut f = json!({ "System.Title": format!("Item {id}"), "System.WorkItemType": kind, "System.State": state, "System.IterationPath": "Web\\Sprint 1",
                "System.ChangedDate": "2026-11-02T00:00:00Z", "System.CreatedDate": "2026-10-01T00:00:00Z", "Custom.Blocker": blocker, "System.Tags": "goal" });
            if let Some(who) = who {
                f["System.AssignedTo"] = json!({ "displayName": who, "uniqueName": format!("{who}@x") });
            }
            if let Some(parent) = parent {
                f["System.Parent"] = json!(parent);
            }
            json!({ "id": id, "fields": f })
        };
        if args[0] == "rest" {
            let url = args[args.iter().position(|a| *a == "--url").unwrap() + 1];
            if url.contains("workitems?ids=") {
                let ids: Vec<u64> = url.split("ids=").nth(1).unwrap().split('&').next().unwrap().split(',').map(|i| i.parse().unwrap()).collect();
                let value: Vec<Value> = ids.iter().map(|id| json!({ "id": id, "relations": if *id == 4 { json!([{ "rel": "ArtifactLink", "url": "vstfs:///Git/PullRequestId/p%2Fr%2F77" }]) } else { json!([]) } })).collect();
                return ok(json!({ "value": value }));
            }
            return ok(json!({ "value": [{ "pullRequestId": 77, "status": "completed", "title": "Done" }] }));
        }
        match args[..3] {
            ["boards", "iteration", "team"] => ok(json!([{ "name": "Sprint 1", "path": "Web\\Sprint 1", "attributes": { "startDate": "2026-10-30T00:00:00Z", "finishDate": "2026-11-20T00:00:00Z" } }])),
            ["boards", "area", "team"] => ok(json!({ "values": [{ "value": "Web", "includeChildren": true }] })),
            ["devops", "invoke", "--area"] => ok(json!({ "value": [{ "name": "User Story", "color": "009ccc", "states": [
                { "name": "New", "category": "Proposed", "color": "b2b2b2" }, { "name": "Active", "category": "InProgress", "color": "007acc" },
                { "name": "Code Review", "category": "InProgress", "color": "ff0000" }, { "name": "Closed", "category": "Completed", "color": "339933" }] },
                { "name": "Task", "color": "f2cb1d", "states": [{ "name": "New", "category": "Proposed" }, { "name": "Active", "category": "InProgress" }, { "name": "Closed", "category": "Completed" }] }] })),
            ["boards", "query", "--wiql"] => {
                let wiql = args[3];
                if wiql.contains("[System.Parent] IN") {
                    ok(json!([row(2, "Task", "Active", None, Some(1), "")]))
                } else if wiql.contains("[System.Id] IN") {
                    ok(json!([row(9, "Task", "Closed", None, None, "")]))
                } else {
                    ok(json!([row(1, "User Story", "Code Review", Some("Ada"), None, ""), row(3, "User Story", "Active", Some("Ada"), None, "#9"), row(4, "User Story", "Code Review", Some("Ada"), None, "")]))
                }
            }
            _ => Err(format!("unexpected {args:?}")),
        }
    }
}

pub fn settings() -> Settings {
    Settings {
        org: "https://dev.azure.com/acme".into(),
        project: "Web".into(),
        team: "Web Team".into(),
        members: vec!["Ada".into()],
        blocked_by_field: "Custom.Blocker".into(),
        goal_tag: "goal".into(),
        scope_child_types: Vec::new(),
        ..Settings::default()
    }
}

