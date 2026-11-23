# Demo runbook: recording the Relay videos

Both videos are made from the running application by scripts in `app/e2e/demo/`, so they can be recorded again
after any change. Nothing in them is mocked: the footage is Chrome's own screencast of the real app. The only
additions are captions, a visible pointer, scene labels, zooms, and an on-screen marker wherever the model's
thinking time was cut.

## What you need

| Requirement | Used for |
| --- | --- |
| The dev server, with `RELAY_TEST_HOOKS=true`, `FIBER_MODE=fixture` and SMTP pointed at Mailpit | The app being recorded. The capture resets all cases |
| Mailpit on `:1025` / `:8025` | The follow-up email shown in the demo |
| Ollama with `qwen2.5:3b` (the model must be on) | The chat intake and the coordinator's reviews |
| Google Chrome, and `npm install` in `app/e2e` | Capture, rendering and encoding (Chrome's MediaRecorder writes H.264/AAC MP4); no other video tool is needed |
| Windows (for narration) | The built-in OneCore voices (`Microsoft Mark` by default; set `DEMO_VOICE` to choose another) |

## Record the product demo

From `app/e2e`:

```bash
node demo/capture-product.mjs ../../demo-out/product                    # 15–30 min: real model turns on CPU
node demo/make-product.mjs ../../demo-out/product ../../demo-out/relay-product-demo.mp4
```

**What the capture does:**

1. Resets the cases and creates three background reports through the API (not shown): a dishwasher, an air
   conditioner at a property with no approved heating and cooling vendor, and a possible emergency.
2. Waits until Relay AI has reviewed each of them.
3. Records 13 scenes of real interaction, one browser session per person:
   - **Priya, resident (phone):** chat intake.
   - **Morgan, manager:** the command center and the case workspace.
   - **Vendor discovery:** verify a business and approve it.
   - **Sam, contractor (phone):** accept with an estimate.
   - **Approvals and the visit:** the manager approves the money, the resident picks a time, the contractor
     completes.
   - **Follow-up:** in-app and in the Mailpit inbox, then "Yes, resolved", and the audit trail.
   - **Edge cases:** a vague report, and another contractor refused access.

`facts.json` records what the model actually did in that run (for example whether the coordinator proposed a
vendor), and the narration follows it.

**What `make-product.mjs` does:**

- synthesises the narration (`narration.mjs`);
- renders the title and end cards;
- builds the timeline (`timeline.mjs`);
- writes the captions (`.srt`, `.vtt`);
- renders in real time with `render.mjs` (about 5 minutes).

## Record the technical walkthrough

```bash
node demo/make-technical.mjs ../../demo-out/product ../../demo-out/relay-technical-walkthrough.mp4 https://github.com/elaineh16/yc-hackathon/actions/runs/<run id>
```

The video is made of:

- slides from `technical.mjs`, built from the codebase and `docs/evidence`;
- an excerpt of the real product footage (the coordinator's recorded tool calls);
- a screenshot of the real CI run.

## Check the result

```bash
node demo/inspect-video.mjs <video.mp4> <dir> 30 60 90          # duration, size, audio track, frame grabs
node demo/playback-check.mjs <video.mp4> <dir> 30 60 90         # grabs while playing, as a viewer sees it
```

## Editing rules the scripts follow

- **Cuts:** only the model's thinking time is cut. Each cut is marked on screen with the seconds removed.
- **Speed:** long footage under short narration may play up to 1.6x; outcomes are never changed.
- **Fiber:** discovery runs in fixture mode (fictional businesses through the real SDK path). The scene label
  and the narration say so, and the app's own panel shows "Fixture data". It is never presented as live Fiber.
- **Voice:** voice intake is not recorded; the narration says the recording uses text chat.
- **Accounts:** the demo accounts and their shared password are for local development only (see the README).
