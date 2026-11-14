# The practitioner's runtime

> Status: the contract for `@acucraft/agent` and `@acucraft/mcp`. If the code and this page disagree, fix one of them
> in the same change. Built and tested without access to a live model: every test of the loop runs against a scripted
> provider or a stand-in for the SDK client (§9).

Whoever plays the practitioner — the rule-based baseline, a language model, an agent in another program, a person —
sees the same view and acts through the same requests. This page is about how a language model does it: the tools it
is given, how its turns become engine steps, what it is told back, and how the same tools are served to another
program over MCP. The approach follows ClinicalCraft's agent runtime (typed tools with a read/act split, a provider
behind neutral types, a loop that never throws, skills as data, an MCP server) cut to what one practitioner in one
clinic needs.

```
 an encounter (engine)      EncounterSession  ── act(action) ──▶ step ──▶ attempt, new view
                                   ▲  view()                                  │
                                   │                                          ▼ outcome: what it did, what changed
 runner (bench) ── next(view) ──▶ llmAgent ──▶ tools: one per action · lookup · view · construct_point · read_skill
                                   │  ▲
                        ChatRequest│  │Completion          provider: anthropic (Messages API) · scripted · oracle
                                   ▼  │
                                 a model
```

## 1. Agents

`Agent` (`types.ts`): `init({actorId, library})`, `next(view)` → one action or `done` (with a note), and for a model
`transcript()` and `usage()`. The runner (`@acucraft/bench`) asks for one action at a time and steps the engine.

| agent | `--agent` | what it is |
|---|---|---|
| `referenceAgent` | `reference` | replays the scenario's hidden reference trajectory: an oracle and a check on the scenario |
| `protocolAgent` | `protocol` | the rule-based baseline: a fixed screening list, a standard prescription per complaint, honest localisation, textbook depths ([EVALUATION.md](EVALUATION.md)) |
| `claudeAgent` | `claude` | a language model through the Messages API: `llmAgent` over `anthropicProvider` |
| `llmAgent` + `oracleProvider` | `scripted-llm` | the reference trajectory spoken as tool calls through the same loop — no network, no fairness: an instrument (§9) |

## 2. Tools

A model's tools are fixed for the encounter (`toolsFor(view.you.may)`): what its role may do when the encounter
begins.

**Action tools** (`tools/actions.ts`) — one for each action of the action interface, named after it (`ask`, `move`,
`insert_needle` …; 48 in the engine, 46 for a TCM physician here). The input is the action without `type`.

- The input schema is generated from the engine's own zod schema of that action (`tools/schema.ts`): required fields,
  bounds, enums, unions and defaults are the engine's. A new construct in an action makes the generator throw rather
  than emit `{}`.
- The description says what the act is for, what it needs within reach ([WORLD.md](WORLD.md)) and what it leaves on
  the record. It is what a newcomer to this clinic would be told, and nothing in it depends on a scenario.
- Calling one is the only way to change anything. The harness parses the input with `ActionSchema` first: an input the
  engine would not parse is answered as an error naming the field, and **nothing reaches the engine** — it is not an
  action and costs no step.

**Read-only tools** (`tools/reference.ts`) take no simulated time and change nothing. They read the public library
and the practitioner's own view, never the scenario:

| tool | gives |
|---|---|
| `lookup {topic, id?}` | the reference library: `points`, `point`, `region`, `regions`, `vocabulary`, `pattern`, `deqi`, `clinic`, `floorplan`, `roles`, `rules`, `evidence` |
| `view {section?}` | the whole view, or one section of it |
| `construct_point {point, side?, site?}` | where a standard point lies on this patient's chart, from the landmarks the practitioner palpated and the segments they measured in this visit: the point's public construction applied to their own observations. While something is missing it lists what to palpate and measure; once located it returns the position and an input ready for `mark_point`. A landmark palpated in another configuration of its chart no longer counts |
| `read_skill {id}` | one of the clinic's skills in full (§5) |

`construct_point` does arithmetic the rule-based baseline has always done (`localise.ts`); a model without it is
measured on its arithmetic as well as on its localisation. It is on by default and can be withheld (`--no-locate`,
`locate: false`); which was used belongs in any report of results.

## 3. The loop

`llmAgent({provider, skills, …})` (`llm.ts`). A model's turn may hold several tool calls; the runner wants one action
at a time. So:

1. The calls of a turn are worked through in order. A read-only call is answered at once. An action call is
   validated and handed to the runner; its result is written when the runner returns with the next view.
2. **A batch stops when it should.** If an action is rejected, blocked or only partly executed, or the patient's
   appearance or consent changes, or someone speaks who was not being spoken to, the calls after it are not carried
   out: each is answered `{"skipped": true, "reason": …}` and the model decides again. A queued needle is never
   inserted into a patient who has just said "stop".
3. Every call of the turn is answered in **one** message, then the model is asked for its next turn.
4. A turn without a tool call is nudged (twice), then the agent stops. A reply cut off at the output limit is never
   executed — a cut-off tool input can parse as a valid, wrong one — and is asked for again with more room, once.
   A refusal, a provider failure, too many model turns between two actions (`maxCallsPerTurn`, default 8) or in all
   (`maxModelCalls`, default 800) end the agent's part with a note. The loop does not throw for anything the model
   or the provider did; the note is in the episode log (`meta.note`) and on the command line.
5. `approve(action, view)` can refuse an action before it reaches the engine (a person supervising the agent). The
   refusal goes back to the model as that call's result.

The conversation is only ever appended to, and an assistant turn is sent back exactly as it came
(`ChatMessage.raw`). The standing instructions and the tools are identical on every request. Two things follow: a
provider's prompt cache holds the growing prefix, and a model's own blocks (thinking, compaction) stay valid.

## 4. What the model is told

**The standing instructions** (`prompt.ts`; `npm run acu -- prompt`) describe the environment in six short sections:
the role; how the simulation answers (tools, results, batches, what can be known); conclusions and their evidence;
the clinic as a place; charts, points and depth; what must hold (consent, single-use needles, observation, the
count, closing a visit). Then the index of skills. They carry no per-action catalogue — each action's conditions
are on its tool — and nothing about any case.

**The opening** is the whole view, once.

**After each action** (`render.ts`): `status`, the engine's `message` and `observations`, the minute, and `changed` —
what that action changed in the view, section by section: words said, new evidence *with its content and id*, where
the practitioner now stands and what is in reach, the patient's position and consent, landmarks, measurements and
marks, each needle whose state or evidence changed, packs and needles, tasks, counts. Nothing is repeated that did not
change; the whole of anything is one `view` away. Everything in a result comes from the practitioner's own view.

## 5. Skills

`content/skills/<id>.md` — how a part of the work is done in this clinic, as a short text with a header:

```
---
id: closing-a-visit
title: Closing a visit, from the last minute of retention to end_visit
when: When the retention time is up, or the treatment has been stopped.
---
```

The model is given only the index (id, title, when to read it) and reads a skill in full with `read_skill` when it
reaches that work, so the standing instructions stay small. Nine come with the pack: `visit-arc`,
`red-flags-and-referral`, `pattern-differentiation`, `point-location`, `clean-needle-technique`,
`depth-and-direction`, `needle-response`, `observation-and-events`, `closing-a-visit`
(`npm run acu -- skills [id]`).

Skills are data, never code: a skill cannot act, only tools do. They are public reference text, the same for every
scenario. Tests hold them to that and to the tools: each loads, is under 6 000 characters, names only tools, lookup
topics, view sections and skills that exist, and contains no family, pathway, critical-error id, patient name or
point id — a skill says how to work, not which points to choose. `--no-skills` runs a model without them.

Like the rest of the pack's content they are AI-assisted and unreviewed, and they were written by the authors of
the scenarios. Read results with and without them accordingly ([EVALUATION.md](EVALUATION.md) §7).

## 6. Providers

`LLMProvider` (`providers/types.ts`): `complete(request) → Completion | ProviderError`, neutral in both directions
(`ChatMessage` with text, tool-call and tool-result parts; a stop reason; usage). A provider never throws.

**`anthropicProvider`** — Claude through the official SDK, streamed. `buildAnthropicRequest` is pure and tested:

| a request carries | why |
|---|---|
| `model` (default `claude-opus-5-5`), `output_config.effort` (default `high`, always sent) | current models think adaptively by themselves: there is no `thinking` parameter, and effort is the control. Model defaults differ, so it is explicit |
| `tool_choice: auto` | current models reject a forced choice; the instructions ask for tools and the loop nudges |
| a cache breakpoint on the last section of the instructions, and top-level `cache_control` | tools and instructions are cached once; the conversation's prefix is cached as it grows |
| `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) | a safety classifier's false positive on clinical text does not end an encounter |
| server-side compaction at 300 000 input tokens (beta `compact-2026-01-12`), with instructions on what a summary must keep | a very long encounter stays within the window without the harness editing history |
| `eager_input_streaming` on every tool | inputs stream as generated; the harness validates each one itself (§2) |

After a refusal fallback part-way through a turn, only what the serving model produced counts (`toCompletion`), and
the turn is sent back as the API asks (`echoBlocks`). Errors are told apart by the SDK's typed classes
(`toProviderError`); an overloaded, rate-limited or interrupted request is asked again after a wait (`retries`,
default 3, on top of the SDK's own), and an endpoint that will not take compaction is asked again without it.
Options: `model`, `effort`, `maxTokens` (default 32 000, thinking included), `fallbacks`, `compactAt`, `retries`,
`client`.

**`scriptedProvider(turns)`** plays fixed turns and records every request it received. **`oracleProvider(steps)`**
plays a reference trajectory as tool calls, several a turn if asked, and asks again for calls that were skipped.

Another model family is another provider: implement `complete`.

## 7. Sessions and the log

`EncounterSession` (`session.ts`) is the one way a request gets its id and its version: `view()`, `library()`,
`act(action)` → the attempt, the new view and the outcome as a practitioner is told it, and `log(engine, meta)` — the
replayable `acucraft/log@1`. The runner, the MCP server and tests use it.

An episode's log keeps, in `meta`: the agent's name with its model and effort, why it stopped, a note when it stopped
by itself, `usage` (model turns; input, output, cache-read and cache-write tokens) and the `transcript` — every
response of the model as the provider returned it. A replay never calls the model
([ARCHITECTURE.md](ARCHITECTURE.md) §8).

## 8. MCP

`npm run acu -- mcp` serves encounters over the Model Context Protocol on stdio (JSON-RPC 2.0, one message a line;
`initialize`, `ping`, `tools/list`, `tools/call`; protocol revisions 2025-06-18, 2025-03-26, 2024-11-05). An agent
in another program — Claude Code, Claude Desktop — plays the practitioner with the built-in agent's tools.

| tool | |
|---|---|
| `list_encounters` | the families, each with its title and the number of its variants |
| `start_encounter {family, variant?, seed?, mode?}` | a `session_id` and the opening view. `variant` is a number; without it one is chosen from the seed |
| every tool of §2, with `session_id` | the same schemas, validation and results |
| `get_report {session_id, abandon?}` | the independent evaluation, once the encounter is finished (or abandoned) |

The server's `instructions` are the standing instructions of §4 with a paragraph on sessions. While an encounter is
open the client is served what any agent under test is served: its view and the public library. A variant is never
named, the session id is opaque, and the evaluation exists only after the end (tested). Each closed encounter's
`log.json` and `report.md` are written under `runs/mcp/<session>/` (`--out`). stdout carries protocol messages only.

To register it with Claude Code, from this repository:

```bash
claude mcp add acucraft -- npm run -s acu -- mcp
```

## 9. Tests

`packages/agent/src/*.test.ts`, `packages/mcp/src/mcp.test.ts` — no network anywhere.

- **Tools**: one for every action, closed schemas, the engine's bounds; every action of every reference trajectory
  (1 125 of them) passes through its tool unchanged; invalid inputs are refused with the field named; the read-only
  tools cannot show a variant, a pathway or the evaluation.
- **The loop** (scripted turns): reads cost no time; one engine step per action; one message per turn's results;
  append-only history; invalid input and unknown tools; batches stopped by a refusal and by the patient speaking;
  nudges, refusal, provider failure, budgets, the cut-off reply; the supervisor's veto; the log replays.
- **The whole pilot through the loop**: all 15 scenarios with `oracleProvider`, one and four calls a turn, reach the
  reference's outcome with the same final state digest. `tools/check.sh` runs it as a benchmark too
  (`bench --agent scripted-llm`: 15/15).
- **The Messages API**: the request body field by field; older models; what is sent back after a fallback; error
  classes; retries and the wait between them; compaction withdrawn when refused; an encounter against a stand-in
  client with thinking blocks echoed unchanged.
- **Skills** and **MCP**: as described above.

## 10. Limits

- **No live-model results.** This release was built without API access. The request shape follows the current
  Messages API documentation and the SDK's types; it has not been exercised against the service.
- One practitioner. The support team stays the engine's scripted policies; a model does not voice the patient or
  the assistant.
- One provider for a real model. The neutral types are there for others; none is written.
- A person supervising a model (`approve`) is a function in code, not yet a command-line mode.
