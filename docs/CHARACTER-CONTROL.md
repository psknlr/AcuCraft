# Characters, model providers and needle controls

The browser workspace uses the same clinic coordinates, path planner and role checks as the headless engine. Start it with `npm run acu -- serve`, open an encounter, and use **Clinic movement** to choose the practitioner, assistant or patient. Click a destination on the floor plan, choose a room, or use the four 0.5 m step buttons. An unreachable destination reports an engine rejection; it does not teleport the character through a wall or furniture.

Staff keep their existing role permissions and contact/reach constraints. A patient can `move`, `say` and `wait`; they cannot examine, prescribe, create clinical evidence or grant consent through generated dialogue. Patient walking changes their posture to standing, releases the chair/couch and invalidates old localisation marks. It is refused while they are fainted or a needle (including a broken fragment) is retained. Existing clinician positioning and escort actions remain available.

The 3D view renders the actual clinic floor plan, equipment placements and recorded walks. It retains each person's mesh while walking, follows path corners and adds body sway and clinician gaze to the existing breathing, blinking and speech animation. Patient body height and appearance still come from the scenario. Posture changes rebuild the figure and preserve its seated or lying transform.

## Connect a language model

In **Language model**, choose **Controlled character**, **Model provider**, and optionally a model identifier. The same run controls support pause, resume, stop and approval of each action. The offline reference trajectory is authored only for the practitioner. There is one built-in model run per encounter; stop it before assigning another provider or character. Different encounters can run separately.

Configure credentials in the server process environment, never in the browser:

| Provider | API key | Model | Endpoint base |
| --- | --- | --- | --- |
| OpenAI / GPT | `OPENAI_API_KEY` | `OPENAI_MODEL`, default `gpt-4.1` | `OPENAI_BASE_URL`, default `https://api.openai.com/v1` |
| MiniMax | `MINIMAX_API_KEY` | `MINIMAX_MODEL`, required unless entered in the UI/CLI | `MINIMAX_BASE_URL`, default `https://api.minimax.io/v1` |
| OpenAI-compatible service | `LLM_API_KEY` | `LLM_MODEL`, required unless entered in the UI/CLI | `LLM_BASE_URL`, required |
| Claude | `ANTHROPIC_API_KEY` | Existing Claude model option | Existing Anthropic adapter |

Select a model that supports function/tool calling and a context window large enough for the scenario. A model entered in the UI/CLI overrides its environment default; clear the UI model field to use the server default. Endpoint bases must use HTTPS, except for local loopback services. They are server configuration, not remotely supplied action arguments. Compatible services must accept the Chat Completions tool format; this is not a promise of compatibility with every vendor extension.

For practitioner CLI runs:

```bash
npm run acu -- run sg-knee-oa/base --agent openai --model gpt-4.1
npm run acu -- run sg-knee-oa/base --agent minimax --model YOUR_MINIMAX_TOOL_MODEL
npm run acu -- run sg-knee-oa/base --agent compatible --model YOUR_MODEL
```

The adapter preserves native assistant messages, including MiniMax `reasoning_content` and tool calls, when returning tool results. Malformed tool calls, refusal, truncation, authentication failure, rate limits, cancellation and timeout are handled without bypassing engine validation. Vendor response bodies are not echoed in errors. The connected provider receives the selected character's disclosed encounter view and public reference tools; keep this research simulator's authored cases separate from real patient information.

The existing `LLMProvider` interface remains the extension point for a different protocol. MCP continues to expose the existing practitioner workflow. For actor-aware applications, `EncounterSession.view(actorId)` and `EncounterSession.act(action, actorId)` share one versioned, replayable session. The HTTP action endpoint accepts an optional actor:

```json
{"actor":"patient","tool":"move","input":{"to":{"room":"reception"}}}
```

Send it to `POST /api/encounters/{id}/act`. The agent start endpoint accepts `actor` alongside `provider` and `model`. Unknown characters are rejected. The shared browser record stays in practitioner perspective, and the runner receives its assigned character's view and tools.

## Needle geometry and manipulation

Use **All actions** to open `insert_needle` or `adjust_needle`. These controls are generated from the same schemas supplied to models. Existing clinical prerequisites still apply: assessment and plan, consent, hygiene, localisation, site preparation, posture and physical reach. The engine continues to check regional tissue paths and scenario-specific guards, monitor adverse events, account for sharps and replay every action.

Insertion uses `depthCm` measured **along the shaft**, `angleDeg` measured **from the inward skin normal** (0 is perpendicular; this differs from conventions measured from the skin surface), and `azimuthDeg` in the regional chart (0 toward +v/cranial, 90 toward +u). It also requires the existing named mark or body-chart location. The renderer now uses the executed insertion geometry and the individual needle's recorded length and diameter. A bone-limited insertion is displayed at the executed depth, rather than the originally requested depth; the visible tip is included in that length.

`adjust_needle` adds the following optional parameters:

| Parameter | Unit and meaning | Simulation default / accepted range |
| --- | --- | --- |
| `depthCm` | Nominal depth along the shaft | Current depth; existing depth schema |
| `technique` | `none`, `lift-thrust`, or `rotate` | `none` |
| `strokeMm` | Total peak-to-peak axial travel for `lift-thrust` | 2 mm; greater than 0 through 20 mm |
| `rotationDeg` | Peak angular displacement for alternating rotation, degrees per cycle for one-way rotation | 90 degrees; greater than 0 through 360 degrees |
| `rotationDirection` | `alternating`, `clockwise`, `counterclockwise`, viewed from the handle toward the tip | `alternating` |
| `frequencyHz` | Cycles per second | 1 Hz; 0.1 through 10 Hz |
| `durationSeconds` | Simulated manipulation duration | 30 s; 0.1 through 120 s |

These are software input limits and defaults, **not clinical recommendations**. Stroke fields are valid only for lift/thrust; rotation fields only for rotation. Frequency and duration require a manipulation technique. The full axial envelope is checked: nominal depth plus or minus half the stroke, with millimetres converted to centimetres. An excursion through the skin, beyond the usable shaft or against a path stop is refused; critical structures use the scenario's existing blocking or consequence policy. In consequence mode, effects consider the deepest excursion.

Explicit parameters are retained in the needle event. Duration advances simulation time. The browser and engine share the same motion definition: sinusoidal axial travel, sinusoidal alternating rotation, or constant one-way rotation. Animation ends at its recorded duration and stops on removal, withdrawal of consent, treatment stop, fainting or encounter closure. Animation time is presentation time; the discrete engine commits the action and its elapsed simulation time atomically. Existing unparameterized actions retain their legacy event shape for schema compatibility. Stricter path checks can change results of older logs; retain their originating engine revision for historical digest reproduction.

## Clinical and visual limits

The project remains an unreviewed research simulator. Accurate units and consistent engine/render geometry do not establish anatomical accuracy or clinical validity. Existing head/limb anatomy is schematic, trunk anatomy derives from a reference body, and the rendered skin charts are approximate. The figures are procedural rather than photorealistic; the walk animation has body sway rather than a skinned, articulated gait. Staff path planning checks static clinic obstacles; it does not implement crowd collision avoidance. The physiologic/deqi response remains the existing qualitative per-action model: frequency, rotation amplitude and duration are not a validated biomechanical dose-response model. Hands do not perform inverse-kinematic needle gripping, and tissue deformation is not simulated.

Clinical review should validate point localisation across body sizes/postures, trajectory conventions, tissue boundaries, contraindications, infection prevention, consent, adverse-event response and sharps accounting against qualified practice. Relevant reference frameworks include [WHO benchmarks for the practice of acupuncture](https://www.who.int/publications/i/item/978-92-4-001688-0) and the [Clean Needle Technique Manual](https://www.ccahm.org/ccaom/CNT_Manual.asp). These references are review inputs, not evidence that this implementation complies with them.

Provider protocol references: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) and [MiniMax's OpenAI-compatible API](https://platform.minimax.io/docs/api-reference/text-openai-api).
