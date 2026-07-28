package main

import (
	"testing"

	"github.com/gotd/td/tg"
)

func TestExtractTopicIDFromCreationServiceMessage(t *testing.T) {
	updates := &tg.Updates{Updates: []tg.UpdateClass{
		&tg.UpdateNewMessage{Message: &tg.MessageService{
			ID:     535106,
			Action: &tg.MessageActionTopicCreate{Title: "smoke"},
		}},
	}}

	if got := extractTopicID(updates); got != 535106 {
		t.Fatalf("extractTopicID = %d, want 535106", got)
	}
}

func TestExtractSentMessageIDFromShortResult(t *testing.T) {
	updates := &tg.UpdateShortSentMessage{ID: 535139}

	if got := extractSentMessageID(updates); got != 535139 {
		t.Fatalf("extractSentMessageID = %d, want 535139", got)
	}
}

func TestExtractTopicIDFromMessageIDUpdate(t *testing.T) {
	updates := &tg.Updates{Updates: []tg.UpdateClass{
		&tg.UpdateMessageID{ID: 180},
	}}

	if got := extractTopicID(updates); got != 180 {
		t.Fatalf("extractTopicID = %d, want 180", got)
	}
}
