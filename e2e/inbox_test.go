package main

import (
	"strings"
	"testing"

	"github.com/gotd/td/tg"
)

func TestLiveInboxAcceptsReplyWithinForumTopic(t *testing.T) {
	const goblinID int64 = 8840189548
	const topicID = 180
	inbox := newLiveInbox(goblinID, topicID)

	inbox.onMessage(&tg.Message{
		ID:      200,
		FromID:  &tg.PeerUser{UserID: goblinID},
		Message: "pong",
		ReplyTo: &tg.MessageReplyHeader{
			ReplyToMsgID: 199,
			ReplyToTopID: topicID,
		},
	})

	messages := inbox.snapshot()
	if len(messages) != 1 || messages[0].Text != "pong" {
		t.Fatalf("captured messages = %#v, want one pong", messages)
	}
}

func TestMessageTextIncludesRichMessageContent(t *testing.T) {
	msg := &tg.Message{}
	msg.SetRichMessage(tg.RichMessage{Blocks: []tg.PageBlockClass{
		&tg.PageBlockParagraph{Text: &tg.TextPlain{Text: "BANANA"}},
	}})

	if got := messageText(msg); !strings.Contains(got, "BANANA") {
		t.Fatalf("messageText = %q, want rich message content", got)
	}
}

func TestLiveInboxRejectsAnotherForumTopic(t *testing.T) {
	const goblinID int64 = 8840189548
	inbox := newLiveInbox(goblinID, 180)

	inbox.onMessage(&tg.Message{
		ID:      200,
		FromID:  &tg.PeerUser{UserID: goblinID},
		Message: "wrong topic",
		ReplyTo: &tg.MessageReplyHeader{
			ReplyToMsgID: 199,
			ReplyToTopID: 181,
		},
	})

	if messages := inbox.snapshot(); len(messages) != 0 {
		t.Fatalf("captured messages = %#v, want none", messages)
	}
}
