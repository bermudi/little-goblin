# Voice notes

## Sub-features

Upload audio to a conversation as a speech attachment, transcribe it with the
local `whistle` engine, and keep the transcript on the durable message.

## How to get to it (user POV)

In Chat, hold **Record a voice note** and release to send. **Attach** is not a
substitute: it sends a plain attachment, without `speech: true`, so nothing is
transcribed. To test an audio file, use the curl journey below. The throwaway seed
has transcription off, so enable it first with the settings request below.

## Driving it with curl

Start a throwaway instance and use the origin from its printed `/app/` URL:

```sh
bun run try 496-voice
BASE=http://127.0.0.1:<printed-port>
```

For a repeatable local sample, create a short WAV. Or set `AUDIO` to a short
speech recording you already have.

```sh
espeak -v en-us -w /tmp/voice-note.wav 'hello goblin'
AUDIO=/tmp/voice-note.wav
```

Enable the local engine. Settings uses an ETag: GET it, then send that ETag
as `If-Match` on the POST.

```sh
curl -sS -D /tmp/voice-settings.headers "$BASE/api/app/settings" \
  -o /tmp/voice-settings.json
ETAG=$(awk 'tolower($1)=="etag:" {gsub("\r", "", $2); print $2}' /tmp/voice-settings.headers)
curl -sS -i -X POST "$BASE/api/app/settings" \
  -H 'content-type: application/json' -H "if-match: $ETAG" \
  --data '{"transcription":{"kind":"whistle"}}'
```

Create a conversation, upload the audio as multipart field `file`, then send
the returned `ref` as a `data-attachment` part with `speech: true`. That part
shape is what the app client sends.

```sh
curl -sS -X POST "$BASE/api/app/conversations" \
  -H 'content-type: application/json' --data '{}' -o /tmp/voice-conversation.json
CONV=$(jq -r .id /tmp/voice-conversation.json)
curl -sS -F "file=@$AUDIO;type=audio/wav" \
  "$BASE/api/app/attachments" -o /tmp/voice-upload.json
jq -n --slurpfile upload /tmp/voice-upload.json --arg id "$(cat /proc/sys/kernel/random/uuid)" \
  --arg conv "$CONV" \
  '{conversationId:$conv,message:{id:$id,role:"user",parts:[
    {type:"text",text:"Please transcribe this voice note."},
    {type:"data-attachment",data:($upload[0].ref + {speech:true})}
  ]}}' > /tmp/voice-chat.json
curl -sS -N "$BASE/api/app/chat" -H 'content-type: application/json' \
  --data-binary @/tmp/voice-chat.json
```

## Proof

The stream returns `200` and includes the fake model reply. The transcript is
persisted in the user event under
`$.message.parts[].data.transcript`; inspect the throwaway database:

```sh
sqlite3 -readonly "$HOME_DIR/state/goblin.sqlite" \
  "select seq, json_extract(p.value,'$.data.filename') as filename,
          json_extract(p.value,'$.data.transcript') as transcript
   from events, json_each(json_extract(events.data,'$.message.parts')) p
   where conversation_id='$CONV' and role='user'
     and json_extract(p.value,'$.type')='data-attachment';"
```

The log must also have an `app speech transcribed` line with `conversation`,
`filename`, and `chars`. The first use fetches the `whistle` executable and
model artifacts into the instance's `cache/whistle/`; later use reuses them.

## Gotchas

The throwaway config starts with transcription disabled. `whistle` is local
and needs no API key, but its first use needs network access to fetch its
artifacts. Check `state/goblin.log` if setup or transcription fails.

The `espeak` WAV is synthetic. It proved the upload, transcription, event
storage, and app log path on this instance, but its transcript was inaccurate;
use a real short recording to judge recognition quality. The fake model does
not prove general model behavior.

The browser's hold-to-record microphone flow was not exercised in this run;
the curl journey proves the same uploaded-audio and `speech: true` chat path.
