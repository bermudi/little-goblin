package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/gotd/td/tg"
	"github.com/gotd/td/telegram/message"
	"github.com/gotd/td/telegram/message/styling"
	"github.com/gotd/td/telegram/peers"
	"github.com/gotd/td/telegram/uploader"
)

// GoblinDriver is the harness's handle on goblin. It owns the gotd sender,
// the resolved peers, and a LiveInbox for the target chat.
type GoblinDriver struct {
	api      *tg.Client
	sender   *message.Sender
	uploader *uploader.Uploader
	peers    *peers.Manager
	inbox    *LiveInbox
	env      *Env

	goblinPeer peers.Peer
	chatPeer   peers.Peer
	meID       int64
	topicID    int // 0 = no topic
}

// inboxRegistry holds all inboxes that should receive messages from the
// dispatcher. This avoids double-registering handlers on the same dispatcher
// when creating a forum driver alongside the DM driver.
var inboxRegistry []*LiveInbox

// routeToInboxes is the single set of update handlers that feeds all inboxes.
func routeToInboxes(dispatcher tg.UpdateDispatcher) {
	dispatcher.OnNewMessage(func(_ context.Context, _ tg.Entities, u *tg.UpdateNewMessage) error {
		if m, ok := u.Message.(*tg.Message); ok {
			for _, ib := range inboxRegistry {
				ib.onMessage(m)
			}
		}
		return nil
	})
	dispatcher.OnNewChannelMessage(func(_ context.Context, _ tg.Entities, u *tg.UpdateNewChannelMessage) error {
		if m, ok := u.Message.(*tg.Message); ok {
			for _, ib := range inboxRegistry {
				ib.onMessage(m)
			}
		}
		return nil
	})
	dispatcher.OnEditMessage(func(_ context.Context, _ tg.Entities, u *tg.UpdateEditMessage) error {
		if m, ok := u.Message.(*tg.Message); ok {
			for _, ib := range inboxRegistry {
				ib.onMessage(m)
			}
		}
		return nil
	})
	dispatcher.OnEditChannelMessage(func(_ context.Context, _ tg.Entities, u *tg.UpdateEditChannelMessage) error {
		if m, ok := u.Message.(*tg.Message); ok {
			for _, ib := range inboxRegistry {
				ib.onMessage(m)
			}
		}
		return nil
	})
}

// registerInbox adds an inbox to the global registry and wires the dispatcher
// handlers exactly once.
func registerInbox(dispatcher tg.UpdateDispatcher, inbox *LiveInbox) {
	inboxRegistry = append(inboxRegistry, inbox)
	if len(inboxRegistry) == 1 {
		routeToInboxes(dispatcher)
	}
}

// newDriver creates a driver for DM tests. Must be called inside client.Run.
func newDriver(ctx context.Context, env *Env, dispatcher tg.UpdateDispatcher, api *tg.Client) (*GoblinDriver, error) {
	pm := peers.Options{}.Build(api)
	up := uploader.NewUploader(api)
	sender := message.NewSender(api).WithUploader(up)

	goblinPeer, err := resolvePeer(ctx, pm, env.Goblin)
	if err != nil {
		return nil, fmt.Errorf("resolve goblin %q: %w", env.Goblin, err)
	}

	chatRef := env.Chat
	if chatRef == "" {
		chatRef = env.Goblin
	}
	chatPeer, err := resolvePeer(ctx, pm, chatRef)
	if err != nil {
		return nil, fmt.Errorf("resolve chat %q: %w", chatRef, err)
	}

	self, err := pm.Self(ctx)
	if err != nil {
		return nil, fmt.Errorf("get self: %w", err)
	}

	var goblinID int64
	if u, ok := goblinPeer.(peers.User); ok {
		goblinID = u.ID()
	} else {
		return nil, fmt.Errorf("goblin resolved to non-user peer: %s", goblinPeer.VisibleName())
	}

	inbox := newLiveInbox(goblinID, 0)
	registerInbox(dispatcher, inbox)

	d := &GoblinDriver{
		api:        api,
		sender:     sender,
		uploader:   up,
		peers:      pm,
		inbox:      inbox,
		env:        env,
		goblinPeer: goblinPeer,
		chatPeer:   chatPeer,
		meID:       self.ID(),
	}

	fmt.Fprintf(os.Stderr, "driving as %d; goblin=%d (%s); chat=%s\n",
		d.meID, goblinID, goblinPeer.VisibleName(), chatPeer.VisibleName())
	return d, nil
}

// newForumDriver creates a driver pointed at a forum supergroup + topic.
func newForumDriver(ctx context.Context, env *Env, dispatcher tg.UpdateDispatcher, api *tg.Client) (*GoblinDriver, error) {
	if env.ForumChat == "" {
		return nil, fmt.Errorf("E2E_FORUM_CHAT is required for the forum test")
	}
	pm := peers.Options{}.Build(api)
	up := uploader.NewUploader(api)
	sender := message.NewSender(api).WithUploader(up)

	goblinPeer, err := resolvePeer(ctx, pm, env.Goblin)
	if err != nil {
		return nil, fmt.Errorf("resolve goblin %q: %w", env.Goblin, err)
	}
	chatPeer, err := resolvePeer(ctx, pm, env.ForumChat)
	if err != nil {
		return nil, fmt.Errorf("resolve forum chat %q: %w", env.ForumChat, err)
	}

	self, err := pm.Self(ctx)
	if err != nil {
		return nil, fmt.Errorf("get self: %w", err)
	}

	var goblinID int64
	if u, ok := goblinPeer.(peers.User); ok {
		goblinID = u.ID()
	} else {
		return nil, fmt.Errorf("goblin resolved to non-user peer")
	}

	var topicID int
	if env.ForumTopicID == "create" {
		title := fmt.Sprintf("smoke-%d", time.Now().UnixMilli())
		updates, err := api.MessagesCreateForumTopic(ctx, &tg.MessagesCreateForumTopicRequest{
			Peer:  chatPeer.InputPeer(),
			Title: title,
		})
		if err != nil {
			return nil, fmt.Errorf("create forum topic: %w", err)
		}
		topicID = int(extractTopicID(updates))
		if topicID == 0 {
			return nil, fmt.Errorf("could not discover new forum topic id from updates")
		}
		fmt.Fprintf(os.Stderr, "created forum topic %q id=%d\n", title, topicID)
	} else {
		id, err := strconv.Atoi(env.ForumTopicID)
		if err != nil {
			return nil, fmt.Errorf("E2E_FORUM_TOPIC_ID must be an integer or 'create': %w", err)
		}
		topicID = id
	}

	inbox := newLiveInbox(goblinID, topicID)
	registerInbox(dispatcher, inbox)

	d := &GoblinDriver{
		api:        api,
		sender:     sender,
		uploader:   up,
		peers:      pm,
		inbox:      inbox,
		env:        env,
		goblinPeer: goblinPeer,
		chatPeer:   chatPeer,
		meID:       self.ID(),
		topicID:    topicID,
	}
	fmt.Fprintf(os.Stderr, "forum driver: chat=%s topic=%d\n", chatPeer.VisibleName(), topicID)
	return d, nil
}

// --- sending ---

func (d *GoblinDriver) sendText(ctx context.Context, text string) error {
	d.inbox.reset()
	rb := d.sender.To(d.chatPeer.InputPeer())
	b := &rb.Builder
	if d.topicID != 0 {
		b = b.Reply(d.topicID)
	}
	_, err := b.Text(ctx, text)
	return err
}

func (d *GoblinDriver) sendCommand(ctx context.Context, cmd string) error {
	return d.sendText(ctx, "/"+cmd)
}

func (d *GoblinDriver) sendFile(ctx context.Context, name string, data []byte, caption string) error {
	d.inbox.reset()
	upload, err := d.uploader.FromBytes(ctx, name, data)
	if err != nil {
		return fmt.Errorf("upload: %w", err)
	}
	var captionOpts []message.StyledTextOption
	if caption != "" {
		captionOpts = append(captionOpts, styling.Plain(caption))
	}
	doc := message.UploadedDocument(upload, captionOpts...).Filename(name)
	rb := d.sender.To(d.chatPeer.InputPeer())
	b := &rb.Builder
	if d.topicID != 0 {
		b = b.Reply(d.topicID)
	}
	_, err = b.Media(ctx, doc)
	return err
}

func (d *GoblinDriver) sendVoice(ctx context.Context, name string, data []byte, caption string) error {
	d.inbox.reset()
	upload, err := d.uploader.FromBytes(ctx, name, data)
	if err != nil {
		return fmt.Errorf("upload: %w", err)
	}
	var captionOpts []message.StyledTextOption
	if caption != "" {
		captionOpts = append(captionOpts, styling.Plain(caption))
	}
	doc := message.UploadedDocument(upload, captionOpts...).
		MIME("audio/ogg").
		Filename(name).
		Voice()
	rb := d.sender.To(d.chatPeer.InputPeer())
	b := &rb.Builder
	if d.topicID != 0 {
		b = b.Reply(d.topicID)
	}
	_, err = b.Media(ctx, doc)
	return err
}

// --- awaiting ---

func (d *GoblinDriver) awaitSystemReply() (*LiveMsg, error) {
	return d.inbox.awaitSystemReply(d.env.CommandTimeout)
}

func (d *GoblinDriver) awaitAgentReply() (*LiveMsg, error) {
	return d.inbox.awaitAgentReply(d.env.Timeout, d.env.Settle)
}

func (d *GoblinDriver) awaitVoice() (*LiveMsg, error) {
	return d.inbox.awaitMedia("voice", d.env.Timeout)
}

func (d *GoblinDriver) awaitDocument() (*LiveMsg, error) {
	return d.inbox.awaitMedia("document", d.env.Timeout)
}

func (d *GoblinDriver) awaitPhoto() (*LiveMsg, error) {
	return d.inbox.awaitMedia("photo", d.env.Timeout)
}

func (d *GoblinDriver) resetInbox() {
	d.inbox.reset()
}

// --- helpers ---

// resolvePeer resolves a username or numeric id to a peers.Peer.
func resolvePeer(ctx context.Context, pm *peers.Manager, ref string) (peers.Peer, error) {
	if id, err := strconv.ParseInt(ref, 10, 64); err == nil {
		// Numeric id — resolve as a user.
		u, err := pm.ResolveUserID(ctx, id)
		if err != nil {
			return nil, err
		}
		return u, nil
	}
	return pm.Resolve(ctx, ref)
}

// extractTopicID finds the topic ID from an Updates response.
// The topic's head message ID is what Telegram uses as the topic identifier
// for reply_to_msg_id when sending messages into the topic.
func extractTopicID(updates tg.UpdatesClass) int64 {
	switch u := updates.(type) {
	case *tg.Updates:
		for _, upd := range u.Updates {
			if m, ok := upd.(*tg.UpdateMessageID); ok {
				return int64(m.ID)
			}
		}
	}
	return 0
}
