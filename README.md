# Sprint board for Wings

Adds a list button to the Wings title bar that opens your team's current Azure DevOps sprint in the right sidebar. It checks the board's hygiene for your team's scope, proposes a fix for each problem, and shows who on the team is working on what. While there are findings, the button shows how many.

It only reads. It never changes a work item, posts a comment or creates a ticket: every fix is a proposal for you to apply.

## Set up

The sidebar asks for your organization URL, project, team and team members the first time. Project and team offer the names `az` can see. Settings stay in Wings on your computer.

Under **Scope and board rules** you describe your team's conventions. Empty fields turn their check off.

| Setting | Means |
|---|---|
| Story types | Work item types that count as stories |
| Scope child types | A story is in your team's scope when it has a child of one of these types. Empty puts every story in scope |
| Child types checked | Children of an in-scope story that are checked too |
| Other item types, Title prefixes | Other sprint items in scope when assigned to a team member or titled with a prefix |
| Code review states | States whose linked pull request should still be open |
| Blocked By field | A text field holding the blocking ticket number |
| Goal tag | Tag on the sprint's priority work |
| Added-during-sprint tags | Tags an item created after the sprint started must carry |
| Types that need points, Point fields | Items of these types added during the sprint need every point field set and equal. Titles with "spike" are exempt |
| Parked PR title prefix | A linked PR titled with this is parked on purpose and skips the PR check |
| Stale after | Working days without a change before an in-progress item is stale |

## Checks

In scope: stories with a scope child, their checked children, other matching items, and what they depend on (Blocked By tickets and the stories' Predecessor and Related links). A dependency gets the Blocked By and PR checks, and its fix is to ask its owner.

- **Blocked By not a ticket**: the field is set but doesn't start with a ticket number. A note starting "no ... ticket" alone is fine.
- **Blocked By resolved**: a ticket it names is closed.
- **Status behind the work**: a story in a Proposed state while a child has started, or in its first In Progress state while all its children are done.
- **Status ahead of the PR**: in a code review state with no open PR, or done while a PR is still active.
- **In progress, nobody on it**: an in-progress state with nobody assigned.
- **Stale**: in progress with no change for the set number of working days. Reported only.
- **Added without tags** and **Missing points**: items created after the sprint started.

States are grouped by their Azure DevOps category (Proposed, In Progress, Resolved, Completed), so any process works.

Not covered: an item that waits on unfinished work without saying so in Blocked By. Finding it means reading comments and judging them.

**Working on** lists each team member's open items in the sprint, with the goal tag and whether each is blocked. With a goal tag set, **Blocked with only lower-priority work** says whether everything a person owns is blocked or not goal work while no unassigned goal work is left to pick up, which is worth escalating.

The board is read when Wings starts, every 15 minutes, and on Refresh. A check takes from a handful to a few dozen `az` calls, a few seconds to a quarter of a minute.

## Needs

The [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) with the `azure-devops` extension. When `az` isn't signed in, the sidebar has a Sign in button that runs `az login` and opens your browser.

## Claude

With Wings connected to Claude Code (Plugins, Claude Code, Connect), Claude gets `sprint-board__board_check`, which runs the same check and returns the findings, who is working on what, and the lower-priority test as text.

## Install

Make the package and drop it on the Wings window, or pick it under Plugins, Choose a file:

```sh
git archive --format=zip --output sprint-board.wings-plugin HEAD
```

Then turn it on in Plugins.
