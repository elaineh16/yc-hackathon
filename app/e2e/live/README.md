# Live voice check

`voice-check.mjs` drives the real voice intake with no person at the microphone. It uses real Chrome, the real ElevenLabs agent and the real Relay server. Chrome's fake microphone plays a prepared recording of synthetic speech, so the whole path runs for real:

speech recognition → the agent's model → the `submit_report` client tool → Relay's filing, the call record and the safety net.

It proves the wiring. It does not prove the experience: a person speaking and listening is still the real test.

Each run opens a billable ElevenLabs session and uses about as many seconds of the plan's call allowance as the recording is long. For that reason it is never part of the test suites, and only runs by hand.

## Make the microphone tracks (WSL, with Kokoro installed as in `e2e/demo/tts-kokoro.mjs`)

```bash
cd /tmp/voice && KOKORO_DIR=~/relay-v1/tts node <repo>/app/e2e/demo/tts-kokoro.mjs <repo>/app/e2e/live/speech.json . --voice af_bella
node <repo>/app/e2e/live/make-mic.mjs mic-sink.wav 7 describe.wav 16 confirm.wav 30   # say the report, then confirm it
node <repo>/app/e2e/live/make-mic.mjs mic-silent.wav 40                             # silence: connect and hang up
```

The silences leave room for the agent:

- 7 s for its greeting.
- 16 s for its read-back.
- 30 s for it to file the report and say the result.

The tracks are generated files, so they are not committed.

## Run

The app must be running, with `ELEVENLABS_API_KEY` and `EL_AGENT_INTAKE_ID` set (see `scripts/elevenlabs-setup.mjs`).

```bash
cd app/e2e
node live/voice-check.mjs connect /path/mic-silent.wav out-connect.json   # connects, hears the greeting, hangs up
node live/voice-check.mjs report  /path/mic-sink.wav   out-report.json    # files a report by voice
```

Each run writes a JSON record and a screenshot next to it. The record holds:

- the timings;
- the transcript, as shown on the page;
- the case Relay filed;
- any unfinished voice reports waiting for a manager.
