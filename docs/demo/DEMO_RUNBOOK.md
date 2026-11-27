# Demo runbook: recording the Relay videos

Both videos are made from the running application by scripts in `app/e2e/demo/`, so they can be recorded again
after any change. The footage is Chrome's own screencast of real interactions. The only additions are a visible
pointer, labels, zooms, captions, narration, and an on-screen marker wherever the model's thinking time was cut.

| Video | Made by | What it is |
| --- | --- | --- |
| `relay-product-demo.mp4`, "Relay: from request to resolution" | `capture-fiber.mjs`, `capture-product.mjs`, `make-product.mjs` | The product, end to end: almost all real app footage |
| `relay-technical-walkthrough.mp4` | `make-technical.mjs` | An optional technical deep dive: slides built from the code and the evidence |

## What you need

| Requirement | Used for |
| --- | --- |
| The dev server with `RELAY_TEST_HOOKS=true`, SMTP to Mailpit, and **live Fiber** (`FIBER_API_KEY` in `app/.env.server`, `FIBER_MODE` unset) | The app being recorded. The captures reset all cases (real Fiber searches are kept) |
| Mailpit on `:1025` / `:8025` | The follow-up email |
| Ollama with `qwen2.5:3b` | The chat intake and the coordinator's reviews |
| Google Chrome, and `npm install` in `app/e2e` | Capture, rendering and encoding (Chrome's MediaRecorder writes H.264/AAC MP4) |
| Optional: [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) through `kokoro-js` (see `tts-kokoro.mjs`) | A natural narration voice, run locally. Without it, the built-in Windows voice is used |

The test suites refuse to run against a live-Fiber server, and the captures refuse to run against any other: start
the server one way or the other.

## 1. The live vendor search (Fiber AI)

```bash
cd app/e2e
node demo/capture-fiber.mjs ../../demo-out/fiber
```

- **What it records:** a resident reports an air conditioner at Maple Court, which has no approved heating and
  cooling contractor. Relay finds the gap and proposes a search, because Maple Court is set to ask a manager first.
  The manager approves **one** search, about 2 credits after the balance, reserve and daily-budget checks. The real
  businesses come back with Relay's checks and the provider's `chargeInfo`, and the manager shortlists one.
- **What it never does:** verify, contact or approve a real business.
- **Running it again:** if a live search for the same property and trade is younger than `FIBER_CACHE_DAYS`, Relay
  reuses it with no call and no credits, and says so on screen. `facts.json` records which of the two happened, and
  the narration and label follow it.
- **The record:** `docs/evidence/fiber-live-ui-search.json` and `app/e2e/demo/check-fiber-retention.mjs` (a test
  reset keeps the real search and its spend record; a new case reuses it at no cost).

## 2. The product footage

```bash
node demo/capture-product.mjs ../../demo-out/product            # 20–30 min: real model turns on CPU
node demo/capture-product.mjs ../../demo-out/product --from 4   # resume at a scene, keeping the cases (no reset)
```

**Setup (not recorded):**

- it resets the cases and sets Maple Court to "ask a manager before searching", so nothing is spent;
- it creates, through the API, a dishwasher (repaired by the appliance contractor), water dripping from a light
  fixture (a possible emergency) and a lockout;
- it waits for Relay AI to review each one.

**Scenes, one browser session per person:**

1. The manager's command center.
2. Priya chats with Relay about a leak. Her lines are scripted but answer whatever Relay actually asked; every Relay
   reply is the real model's.
3. The manager's case workspace: Relay's reading, its recorded tool calls, its proposal; the manager sends the offer.
4. The contractor (whichever approved plumber the AI proposed) reviews the request, accepts with a $320 estimate,
   and proposes two times.
5. The manager approves the money with a $350 cap.
6. Priya picks a time.
7. The contractor starts the work and completes it with a note.
8. "Is it fixed?" in the app.
9. The same follow-up email in Mailpit.
10. Priya confirms the fix.
11. Daniel reports the dishwasher as not fixed, and the case reopens.
12. Noor's unclear request.
13. The possible emergency and the lockout, from the manager's side.
14. The other plumber cannot open the job.
15. The resolved case's history and follow-up log.

`facts.json` records what the model actually did, and the narration follows it.

## 3. Narration, then the video

```bash
# Optional natural voice (Kokoro, local). Install once, outside the repo:
#   mkdir -p ~/kokoro && cd ~/kokoro && npm init -y && npm i kokoro-js@1.2.1 --onnxruntime-node-install-cuda=skip
DEMO_TTS=kokoro node demo/make-product.mjs ../../demo-out/product ../../demo-out/fiber ../../demo-out/relay-product-demo.mp4
#   → writes narration.json and asks for the audio:
KOKORO_DIR=~/kokoro node demo/tts-kokoro.mjs ../../demo-out/product/narration.json ../../demo-out/product/audio
DEMO_TTS=kokoro node demo/make-product.mjs ../../demo-out/product ../../demo-out/fiber ../../demo-out/relay-product-demo.mp4
```

Without `DEMO_TTS=kokoro`, `make-product.mjs` uses the Windows voice (`tts.ps1`; `DEMO_VOICE` chooses one).

**What it does:**

- copies the live search scene into the product folder;
- renders the closing card;
- builds the timeline: cuts of model thinking time (marked), at most 1.6x speed on long stretches, zooms, a title
  over the real command center, and who is on screen beside each phone;
- writes the captions (`.srt`, `.vtt`);
- renders in real time with `render.mjs` (about the length of the video).

## 4. Check it as a viewer

```bash
node demo/inspect-video.mjs <video.mp4> <dir> 10 60 120 180 240     # duration, size, tracks, frame grabs
node demo/playback-check.mjs <video.mp4> <dir> 10 60 120 180 240    # grabs while it plays, as a viewer sees it
node demo/av-sync-check.mjs <video.mp4> <fromSeconds> <toSeconds>     # narration start vs caption, around a moment
```

Look at the grabs for readability, the label on every scene, caption placement, and anything that should not be on
screen: an error page, a key or a password. The narration's intelligibility can be checked offline with Windows
speech recognition on 16 kHz copies of the WAVs.

## 5. Docs and release

```bash
node demo/write-docs.mjs ../../demo-out/tech ../../demo-out/relay-technical-walkthrough.mp4 \
  ../../demo-out/product ../../demo-out/relay-product-demo.mp4 --fiber ../../demo-out/fiber \
  --release https://github.com/elaineh16/yc-hackathon/releases/tag/relay-v1.1-preview
gh release upload relay-v1.1-preview ../../demo-out/relay-product-demo.mp4 \
  ../../demo-out/product/relay-product-demo.srt ../../demo-out/product/relay-product-demo.vtt --clobber
```

`write-docs.mjs` writes the timed script, the shot list, the metadata, the captions and stills from the real frames
into `docs/demo/`.

## Editing rules the scripts follow

- **Cuts:** only the model's thinking time is cut, and each cut is marked on screen with the seconds removed.
- **Speed:** long footage under short narration may play up to 1.6x; outcomes are never changed.
- **Fiber:** the discovery scene is the live search (or its labelled reuse), never fixtures presented as live.
- **Voice:** voice intake is not recorded; the narration says the chat is text.
- **Accounts:** the demo accounts and their shared password are for local development only (see the README).
