package main

import (
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gotd/td/tg"
)

// MsgKind classifies a captured message from goblin.
type MsgKind string

const (
	KindSystem MsgKind = "system" // [info].../[ok].../[error].../[warn].../[queued]... (systemReply wrapper)
	KindStatus MsgKind = "status" // 🤔 thinking… + tool slots (🔧→✅/❌)
	KindAgent  MsgKind = "agent"  // streamed assistant response
	KindMedia  MsgKind = "media"  // voice / document / photo
)

// MediaInfo describes the media attached to a message.
type MediaInfo struct {
	Type     string // "none", "voice", "document", "photo"
	FileName string
	MimeType string
}

// LiveMsg is a captured message from goblin, updated as edits arrive.
type LiveMsg struct {
	ID        int
	Text      string
	Kind      MsgKind
	Media     MediaInfo
	FirstSeen time.Time
	LastEdit  time.Time
	EditCount int
	Raw       *tg.Message
}

var (
	systemRe = regexp.MustCompile(`^\[(?:info|ok|error|warn|queued)\] `)
	statusRe = regexp.MustCompile(`^[🤔🔧✅❌🧠⏳]`)
)

func classify(msg *tg.Message) (MsgKind, MediaInfo) {
	media := describeMedia(msg)
	text := msg.Message
	if media.Type != "none" {
		return KindMedia, media
	}
	if systemRe.MatchString(text) {
		return KindSystem, media
	}
	if statusRe.MatchString(strings.TrimSpace(text)) {
		return KindStatus, media
	}
	return KindAgent, media
}

func describeMedia(msg *tg.Message) MediaInfo {
	media := msg.Media
	if media == nil {
		return MediaInfo{Type: "none"}
	}
	if docMedia, ok := media.(*tg.MessageMediaDocument); ok {
		doc, ok := docMedia.Document.(*tg.Document)
		if !ok {
			return MediaInfo{Type: "document"}
		}
		info := MediaInfo{Type: "document", MimeType: doc.MimeType}
		for _, attr := range doc.Attributes {
			if audio, ok := attr.(*tg.DocumentAttributeAudio); ok {
				if audio.Voice {
					info.Type = "voice"
				}
			}
			if fn, ok := attr.(*tg.DocumentAttributeFilename); ok {
				info.FileName = fn.FileName
			}
		}
		return info
	}
	if _, ok := media.(*tg.MessageMediaPhoto); ok {
		return MediaInfo{Type: "photo"}
	}
	return MediaInfo{Type: "none"}
}

// stripSystemTag removes the [tag] prefix from a system reply.
func stripSystemTag(text string) string {
	return strings.TrimSpace(systemRe.ReplaceAllString(text, ""))
}

// LiveInbox captures goblin's incoming messages and edits in a target chat,
// classifies them, and exposes settle-aware awaiters.
type LiveInbox struct {
	mu       sync.Mutex
	msgs     map[int]*LiveMsg
	order    []int
	goblinID int64
	topicID  int // 0 = no topic filter
}

func newLiveInbox(goblinID int64, topicID int) *LiveInbox {
	return &LiveInbox{
		msgs:     make(map[int]*LiveMsg),
		goblinID: goblinID,
		topicID:  topicID,
	}
}

// onMessage processes an incoming or edited message from goblin.
func (ib *LiveInbox) onMessage(msg *tg.Message) {
	if msg == nil {
		return
	}
	// Filter by sender (goblin's bot id).
	if msg.FromID == nil {
		return
	}
	if peer, ok := msg.FromID.(*tg.PeerUser); !ok || peer.UserID != ib.goblinID {
		return
	}
	// Filter by topic.
	if ib.topicID != 0 {
		inTopic := false
		if msg.ReplyTo != nil {
			if hdr, ok := msg.ReplyTo.(*tg.MessageReplyHeader); ok && hdr.ReplyToMsgID == ib.topicID {
				inTopic = true
			}
		}
		if !inTopic {
			return
		}
	}

	id := msg.ID
	kind, media := classify(msg)
	text := msg.Message
	now := time.Now()

	ib.mu.Lock()
	defer ib.mu.Unlock()

	if existing, ok := ib.msgs[id]; ok {
		existing.Text = text
		existing.Kind = kind
		existing.Media = media
		existing.LastEdit = now
		existing.EditCount++
		existing.Raw = msg
	} else {
		ib.msgs[id] = &LiveMsg{
			ID:        id,
			Text:      text,
			Kind:      kind,
			Media:     media,
			FirstSeen: now,
			LastEdit:  now,
			Raw:       msg,
		}
		ib.order = append(ib.order, id)
	}
}

// snapshot returns all captured messages in arrival order (latest state).
func (ib *LiveInbox) snapshot() []*LiveMsg {
	ib.mu.Lock()
	defer ib.mu.Unlock()
	result := make([]*LiveMsg, 0, len(ib.order))
	for _, id := range ib.order {
		if m, ok := ib.msgs[id]; ok {
			result = append(result, m)
		}
	}
	return result
}

// waitFor blocks until a message matches pred or timeout elapses.
func (ib *LiveInbox) waitFor(pred func(m *LiveMsg) bool, timeout time.Duration) (*LiveMsg, error) {
	deadline := time.Now().Add(timeout)
	for {
		for _, m := range ib.snapshot() {
			if pred(m) {
				return m, nil
			}
		}
		if time.Now().After(deadline) {
			var captured []string
			for _, m := range ib.snapshot() {
				captured = append(captured, fmt.Sprintf("%s#%d", m.Kind, m.ID))
			}
			joined := "nothing"
			if len(captured) > 0 {
				joined = strings.Join(captured, ", ")
			}
			return nil, fmt.Errorf("waitFor timed out after %v. Captured: %s", timeout, joined)
		}
		time.Sleep(150 * time.Millisecond)
	}
}

// awaitSystemReply waits for a [tag] ... system message.
func (ib *LiveInbox) awaitSystemReply(timeout time.Duration) (*LiveMsg, error) {
	return ib.waitFor(func(m *LiveMsg) bool { return m.Kind == KindSystem }, timeout)
}

// awaitAgentReply waits for the streamed agent response to settle.
// Picks the newest agent/media message and returns once it has gone settleMs
// without an edit and no newer candidate has appeared.
func (ib *LiveInbox) awaitAgentReply(timeout, settle time.Duration) (*LiveMsg, error) {
	deadline := time.Now().Add(timeout)
	for {
		var candidate *LiveMsg
		for _, m := range ib.snapshot() {
			if m.Kind == KindAgent || m.Kind == KindMedia {
				candidate = m // keep the newest
			}
		}
		if candidate != nil {
			settled := time.Since(candidate.LastEdit) >= settle
			var newer *LiveMsg
			for _, m := range ib.snapshot() {
				if (m.Kind == KindAgent || m.Kind == KindMedia) && m.FirstSeen.After(candidate.FirstSeen) {
					newer = m
				}
			}
			if settled && newer == nil {
				return candidate, nil
			}
		}
		if time.Now().After(deadline) {
			var desc []string
			for _, m := range ib.snapshot() {
				desc = append(desc, fmt.Sprintf("%s#%d(e=%d)", m.Kind, m.ID, m.EditCount))
			}
			joined := "nothing"
			if len(desc) > 0 {
				joined = strings.Join(desc, ", ")
			}
			return nil, fmt.Errorf("awaitAgentReply timed out after %v. Captured: %s", timeout, joined)
		}
		time.Sleep(150 * time.Millisecond)
	}
}

// awaitMedia waits for a message with the specified media type.
func (ib *LiveInbox) awaitMedia(mediaType string, timeout time.Duration) (*LiveMsg, error) {
	return ib.waitFor(func(m *LiveMsg) bool { return m.Media.Type == mediaType }, timeout)
}

// reset clears captured state (called before each send).
func (ib *LiveInbox) reset() {
	ib.mu.Lock()
	defer ib.mu.Unlock()
	ib.msgs = make(map[int]*LiveMsg)
	ib.order = nil
}
