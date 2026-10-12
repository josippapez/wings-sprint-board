# Sprint board for Wings

Adds a list button to the Wings title bar that opens your team's current Azure DevOps sprint in the right sidebar: a small, read-only Azure Boards. The button shows how much is in progress and how much is blocked.

It only reads. It never changes a work item, posts a comment or creates a ticket.

## The board

Every item of the current sprint in your team's areas, grouped by state in workflow order. Done work starts folded. Stories carry their tasks underneath, folded to a done count like 3/8. Each row shows the type's colour, the id, the title, who it's assigned to, and chips: **Blocked** when the Blocked By field names unfinished work, **PR** with the linked pull request's status where the checks read it, **!** when a board check flags the item, and the comment count.

Search by id or title, and filter by person (Everyone, Mine, Unassigned or anyone in the sprint) and type. Mine is whoever `az` is signed in as. The filters and what's folded are remembered.

Click a row for the item: its state, assignee, iteration, area, tags, parent, children, what blocks it, its pull requests, the description and acceptance criteria, and the discussion, oldest comment first. Item links open in the sidebar; **Open in Azure DevOps** opens the browser. Text from Azure DevOps is shown as text: formatting is rebuilt from paragraphs, lists and emphasis only, images show as [image], and only Azure DevOps links open.

The list comes from the last board check, so it costs nothing to open. An item reads its details and comments when you open it (two calls) and each pull request after that, and keeps them until the board shows a newer revision of it.

## Set up

Open the sidebar and it works out what it can, reading only, then walks you through it a question at a time. Each step has the detected answer picked, says why it was picked, and shows an example from your sprint of what the answer does. **Next** (or Enter) goes on, **Back** keeps your answers, **Turn this check off** skips an optional check, and **Use detected for the rest** saves straight away. Settings opens the same steps later.

1. **Where is your board?** The organization and project, from the Azure DevOps repos open in your Wings panes.
2. **Which team's sprint?** Of the teams you're in, the one whose current sprint has the most items.
3. **Whose work do you follow?** You, as `az` is signed in. Add teammates you look after. This is for the board checks; the board's own filters don't depend on it.
4. **Stories and their tasks.** Stories come from the process's requirement types, tasks from the types under them. Optionally, which task types mark a story as your team's.
5. **Other work.** Types outside stories that count when one of your people has them or their title starts with a prefix.
6. **What blocks an item.** A text field holding the blocking ticket's number.
7. **Priority work.** The tag on the sprint's goal work.
8. **Work added after the sprint started.** The tags it must carry, and which types need points.
9. **Code review states,** in which an item should have an open pull request, and a title prefix for pull requests parked on purpose.
10. **Stale work.** Working days without a change.

Settings stay in Wings on your computer. Empty answers turn their check off.

## Board checks

The Checks tab lists problems on the board for your team's scope, each with a fix for you to apply.


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
npm install
npm run check              # type-checks src/ and writes sprint-board.wings-plugin
```

Then turn it on in Plugins.

## Develop

The code is TypeScript in `src/`: `src/main.ts` is the background check and `src/sidebar.tsx` the sidebar page, in React on `wings-plugin-sdk/ui`, with its own bits in `src/sidebar.css` and its modules in `src/lib/` and `src/components/`. The repo holds only source: `npm run check` builds the plugin into `sprint-board.wings-plugin` (with the generated `sidebar.html`), which isn't committed; a release builds it.
