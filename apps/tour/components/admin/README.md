# Tour admin design system

This is the house pattern for every management surface in `apps/tour` (anything a TO,
mod, or captain operates -- `/admin/**`, the team-page manage panels, the mod inbox).
It exists so the admin side reads as one tool instead of a pile of per-page layouts.

**"Are we using a framework?" Yes -- this is it.** We do not adopt a third-party UI
framework (no MUI / Chakra / etc.); we build on our own Tailwind tokens. What makes it a
*framework* and not vibes is that the pattern below is (a) written down here, (b) enforced
by a loaded rule (`.claude/rules/tour-admin-ux.md`), and (c) embodied in the shared
primitives in this folder. Build new admin surfaces from these, don't hand-roll.

## Where the pattern comes from (reference standards)

Not invented -- triangulated. A rule is in here only if two of three agree:

- **Heuristics (the "why humans"):** Nielsen Norman Group -- Data Tables (inline row
  actions beat re-selecting a target; modals are wrong because they hide sibling rows),
  Progressive Disclosure, Command/Form interfaces (legit for expert operators + complex
  heterogeneous data entry -- which roster ops are), Wizards (only for ordered dependent
  steps). Plus Hick's Law (every always-expanded option taxes every visit).
- **Convergent design systems (the "everyone serious landed here"):** Ant Design (Pro
  PageContainer, editable-row), Carbon (`>5 secondary items -> side-nav`, `>=3 row actions
  -> kebab`), Polaris (one primary action per section, Resource-Index hub). Four systems,
  different companies, same toolbar / row-inline / batch-bar model.
- **Domain precedent (the "people solving this exact problem"):** Battlefy, Challonge,
  start.gg edit a roster as one table with inline row actions, never a form stack;
  Toornament / Stripe Radar for the approval-queue shape.

Full brief with citations: the Management UX Design Brief (Artifact
`c61e4dba-41ae-4051-90d6-f56d1f150b73`).

## The house pattern (how you operate on a collection)

**Toolbar (global actions) - row-inline actions (<=2 buttons, or an end-of-row kebab for
>=3) - contextual batch bar (checkbox column + action bar on selection).**

- Actions live **on the row you are already reading** -- never "select a target from a
  rebuilt dropdown, then act."
- Single-record edit: **inline-in-place** for narrow scalar fields; a **non-modal side
  panel / `<details>`** for rich review. **Never a modal** (it covers the sibling rows an
  operator needs to reference).
- Rare / dangerous / mod-only ops hide behind **progressive disclosure** (`<details>`),
  never rendered at the same weight as daily ops.
- Append-only truth: roster edits write a `RosterMove`, never mutate a raw field; "undo"
  is a reversing move or a confirm-before-commit, never a silent delete.

## The kit (build once, wrap everywhere)

| Primitive | Enforces |
| --- | --- |
| `AdminPageHeader` | one back-link + title(+icon) + one right-aligned primary action + sub. Replaces the copy-pasted `<p><Link ArrowLeft/></p><h1>` block. |
| `Section` | the one card grouping unit (`.card` + optional bracket-title + description + action slot). Retire bare `<h2>` + ad-hoc `.card`. |
| `EmptyState` | one calm centered empty card (neutral / success tones). Retire the "bare `<p>` here, `<Callout>` there" split. |
| `Field` + `fieldInput` / `fieldInputSm` | the single input class (two densities). Import it; never re-declare a local `inputCls`. |

## Hard rules (non-negotiable)

1. **Every mutation goes through `<ActionFlashForm>`** -- never a raw `<form>`. Admin
   buttons must show a result flash (project tenet).
2. **Actions attach to the row**, not a separate target-picker. `>=3` row actions collapse
   into a kebab / `<details>`.
3. **Progressive disclosure** for rare + mod-only + destructive ops. Never flat.
4. **One primary action per Section** (Polaris). Destructive = `ConfirmButton` + danger
   styling, in a footer danger zone, not next to the title.
5. **Gate by capability, don't disable-and-show.** A captain sees their own team's common
   ops; mod/TO-only ops are *absent*, not greyed (`lib/permissions.ts`).

## Building a new admin surface (checklist)

- [ ] `AdminPageHeader` for the top (back + title + one primary).
- [ ] Group content in `Section`s; use `EmptyState` for empty lists.
- [ ] Collection -> one table, row-attached actions, kebab/`<details>` for the long tail.
- [ ] Inputs use `fieldInput` / `fieldInputSm`; every submit is an `ActionFlashForm`.
- [ ] Capability-gate what renders. Live surfaces wire `<LiveRefresh>` + pg NOTIFY.

## Status (honest)

Codified + enforced by default. Adoption is **incremental, surface by surface** (the brief's
guidance -- no big-bang rewrite). Adopted so far: the mod requests inbox and roster-ops page
(`AdminPageHeader`, `EmptyState`, `Section`, `fieldInputSm`); admin access/config/fantasy use
the shared `fieldInput`. The `TeamManagePanel` row-table rewrite already embodies the row-
attached-actions rule. Remaining admin pages pick these up as they're next touched.

**Not yet done:** measured usability testing with real TOs/captains -- everything here is
best-*grounded*, not best-*measured*. The convergence argument above is the strongest basis
short of putting the UI in front of real operators.
