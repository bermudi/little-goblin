package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/gotd/td/constant"
	"github.com/gotd/td/telegram/message"
	"github.com/gotd/td/telegram/message/styling"
	"github.com/gotd/td/telegram/peers"
	"github.com/gotd/td/telegram/uploader"
	"github.com/gotd/td/tg"
)

// GoblinDriver is the harness's handle on goblin. It owns the gotd sender,
// the resolved peers, and a LiveInbox for the target chat.
type GoblinDriver struct {
	ctx      context.Context
	api      *tg.Client
	sender   *message.Sender
	uploader *uploader.Uploader
	peers    *peers.Manager
	inbox    *LiveInbox
	env      *Env

	goblinPeer    peers.Peer
	chatPeer      peers.Peer
	meID          int64
	topicID       int // 0 = no topic
	createdTopic  bool
	lastSentID    int
	historyTraced bool
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

	goblinPeer, err := resolvePeer(ctx, pm, api, env.Goblin)
	if err != nil {
		return nil, fmt.Errorf("resolve goblin %q: %w", env.Goblin, err)
	}

	chatRef := env.Chat
	if chatRef == "" {
		chatRef = env.Goblin
	}
	chatPeer, err := resolvePeer(ctx, pm, api, chatRef)
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
		ctx:        ctx,
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

// newDMTopicDriver creates a driver pointed at one private-chat topic in
// Goblin's DM. Telegram represents these as replies to the topic root message.
func newDMTopicDriver(ctx context.Context, env *Env, dispatcher tg.UpdateDispatcher, api *tg.Client) (*GoblinDriver, error) {
	if env.DMTopicID == "" {
		return nil, fmt.Errorf("E2E_DM_TOPIC_ID is required for the DM topic test")
	}

	pm := peers.Options{}.Build(api)
	up := uploader.NewUploader(api)
	sender := message.NewSender(api).WithUploader(up)

	goblinPeer, err := resolvePeer(ctx, pm, api, env.Goblin)
	if err != nil {
		return nil, fmt.Errorf("resolve goblin %q: %w", env.Goblin, err)
	}
	goblinUser, ok := goblinPeer.(peers.User)
	if !ok {
		return nil, fmt.Errorf("goblin resolved to non-user peer: %s", goblinPeer.VisibleName())
	}
	self, err := pm.Self(ctx)
	if err != nil {
		return nil, fmt.Errorf("get self: %w", err)
	}

	createdTopic := false
	var topicID int
	if env.DMTopicID == "create" {
		topicID, err = createTopic(ctx, api, goblinPeer, fmt.Sprintf("smoke-%d", time.Now().UnixMilli()))
		if err != nil {
			return nil, fmt.Errorf("create DM topic: %w", err)
		}
		createdTopic = true
	} else {
		topicID, err = strconv.Atoi(env.DMTopicID)
		if err != nil || topicID <= 0 {
			return nil, fmt.Errorf("E2E_DM_TOPIC_ID must be a positive integer or 'create'")
		}
	}

	inbox := newLiveInbox(goblinUser.ID(), topicID)
	registerInbox(dispatcher, inbox)

	d := &GoblinDriver{
		ctx:          ctx,
		api:          api,
		sender:       sender,
		uploader:     up,
		peers:        pm,
		inbox:        inbox,
		env:          env,
		goblinPeer:   goblinPeer,
		chatPeer:     goblinPeer,
		meID:         self.ID(),
		topicID:      topicID,
		createdTopic: createdTopic,
	}
	fmt.Fprintf(os.Stderr, "DM topic driver: chat=%s topic=%d\n", goblinPeer.VisibleName(), topicID)
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

	goblinPeer, err := resolvePeer(ctx, pm, api, env.Goblin)
	if err != nil {
		return nil, fmt.Errorf("resolve goblin %q: %w", env.Goblin, err)
	}
	chatPeer, err := resolvePeer(ctx, pm, api, env.ForumChat)
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
	createdTopic := false
	if env.ForumTopicID == "create" {
		title := fmt.Sprintf("smoke-%d", time.Now().UnixMilli())
		topicID, err = createTopic(ctx, api, chatPeer, title)
		if err != nil {
			return nil, fmt.Errorf("create forum topic: %w", err)
		}
		createdTopic = true
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
		ctx:          ctx,
		api:          api,
		sender:       sender,
		uploader:     up,
		peers:        pm,
		inbox:        inbox,
		env:          env,
		goblinPeer:   goblinPeer,
		chatPeer:     chatPeer,
		meID:         self.ID(),
		topicID:      topicID,
		createdTopic: createdTopic,
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
	updates, err := b.Text(ctx, text)
	if err != nil {
		return err
	}
	d.lastSentID = extractSentMessageID(updates)
	return nil
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
	deadline := time.Now().Add(d.env.Timeout)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, fmt.Errorf("awaitAgentReply timed out after %v", d.env.Timeout)
		}
		window := min(remaining, time.Second)
		if reply, err := d.inbox.awaitAgentReply(window, d.env.Settle); err == nil {
			return reply, nil
		}
		reply, err := d.latestHistoryReply()
		if err != nil {
			return nil, err
		}
		if reply != nil {
			return reply, nil
		}
	}
}

func (d *GoblinDriver) awaitVoice() (*LiveMsg, error) {
	return d.awaitMedia("voice")
}

func (d *GoblinDriver) awaitDocument() (*LiveMsg, error) {
	return d.awaitMedia("document")
}

func (d *GoblinDriver) awaitPhoto() (*LiveMsg, error) {
	return d.awaitMedia("photo")
}

func (d *GoblinDriver) awaitMedia(mediaType string) (*LiveMsg, error) {
	deadline := time.Now().Add(d.env.Timeout)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, fmt.Errorf("await %s timed out after %v", mediaType, d.env.Timeout)
		}
		window := min(remaining, time.Second)
		if reply, err := d.inbox.awaitMedia(mediaType, window); err == nil {
			return reply, nil
		}
		reply, err := d.latestHistoryReply()
		if err != nil {
			return nil, err
		}
		if reply != nil && reply.Media.Type == mediaType {
			return reply, nil
		}
	}
}

func (d *GoblinDriver) resetInbox() {
	d.inbox.reset()
}

// latestHistoryReply is a fallback for Telegram updates represented as
// UpdatesTooLong/short forms that tg.UpdateDispatcher intentionally drops. It
// is keyed to the message just sent, so an older bot reply cannot satisfy the
// current assertion.
func (d *GoblinDriver) latestHistoryReply() (*LiveMsg, error) {
	if d.lastSentID == 0 {
		return nil, nil
	}
	history, err := d.api.MessagesGetHistory(d.ctx, &tg.MessagesGetHistoryRequest{
		Peer:  d.chatPeer.InputPeer(),
		Limit: 20,
	})
	if err != nil {
		return nil, fmt.Errorf("poll Telegram history: %w", err)
	}
	modified, ok := history.AsModified()
	if !ok {
		return nil, nil
	}
	if os.Getenv("E2E_TRACE_HISTORY") == "1" && !d.historyTraced {
		d.historyTraced = true
		fmt.Fprintf(os.Stderr, "history fallback: sent=%d messages=%d\n", d.lastSentID, len(modified.GetMessages()))
		for _, raw := range modified.GetMessages() {
			if msg, ok := raw.(*tg.Message); ok {
				from := int64(0)
				if peer, ok := msg.FromID.(*tg.PeerUser); ok {
					from = peer.UserID
				}
				_, rich := msg.GetRichMessage()
				fmt.Fprintf(os.Stderr, "  message id=%d from=%d plain=%d rich=%t\n", msg.ID, from, len(msg.Message), rich)
			}
		}
	}

	var newest *tg.Message
	for _, raw := range modified.GetMessages() {
		msg, ok := raw.(*tg.Message)
		if !ok || msg.ID <= d.lastSentID {
			continue
		}
		fromGoblin := false
		if from, ok := msg.FromID.(*tg.PeerUser); ok {
			fromGoblin = from.UserID == d.inbox.goblinID
		} else if !msg.Out {
			// Private-dialog history can omit FromID; an incoming message in
			// the bot peer's dialog is necessarily from that bot.
			if peer, ok := d.chatPeer.(peers.User); ok {
				fromGoblin = peer.ID() == d.inbox.goblinID
			}
		}
		if !fromGoblin {
			continue
		}
		kind, _ := classify(msg)
		if kind != KindAgent && kind != KindMedia {
			continue
		}
		if newest == nil || msg.ID > newest.ID {
			newest = msg
		}
	}
	if newest == nil {
		return nil, nil
	}
	kind, media := classify(newest)
	now := time.Now()
	return &LiveMsg{
		ID:        newest.ID,
		Text:      messageText(newest),
		Kind:      kind,
		Media:     media,
		FirstSeen: now,
		LastEdit:  now,
		Raw:       newest,
	}, nil
}

func (d *GoblinDriver) cleanupCreatedTopic(ctx context.Context) error {
	if !d.createdTopic {
		return nil
	}
	if _, err := d.api.MessagesDeleteTopicHistory(ctx, &tg.MessagesDeleteTopicHistoryRequest{
		Peer:     d.chatPeer.InputPeer(),
		TopMsgID: d.topicID,
	}); err != nil {
		return fmt.Errorf("delete smoke topic %d: %w", d.topicID, err)
	}
	return nil
}

// --- helpers ---

// resolvePeer resolves a username or Bot API/TDLib numeric peer id. Numeric
// channel ids need an access hash, so prime the peer manager from the driving
// account's dialogs before resolving them.
func resolvePeer(ctx context.Context, pm *peers.Manager, api *tg.Client, ref string) (peers.Peer, error) {
	id, err := strconv.ParseInt(ref, 10, 64)
	if err != nil {
		return pm.Resolve(ctx, ref)
	}

	dialogs, err := api.MessagesGetDialogs(ctx, &tg.MessagesGetDialogsRequest{
		Limit:      100,
		OffsetPeer: &tg.InputPeerEmpty{},
	})
	if err != nil {
		return nil, fmt.Errorf("load dialogs for numeric peer: %w", err)
	}
	modified, ok := dialogs.AsModified()
	if !ok {
		return nil, fmt.Errorf("load dialogs for numeric peer: Telegram returned an unmodified dialog set")
	}
	if err := pm.Apply(ctx, modified.GetUsers(), modified.GetChats()); err != nil {
		return nil, fmt.Errorf("cache dialog peers: %w", err)
	}

	return pm.ResolveTDLibID(ctx, constant.TDLibPeerID(id))
}

func extractSentMessageID(updates tg.UpdatesClass) int {
	switch u := updates.(type) {
	case *tg.UpdateShortSentMessage:
		return u.ID
	case *tg.UpdateShortMessage:
		return u.ID
	case *tg.UpdateShortChatMessage:
		return u.ID
	case *tg.Updates:
		return sentMessageIDFromUpdates(u.Updates)
	case *tg.UpdatesCombined:
		return sentMessageIDFromUpdates(u.Updates)
	case *tg.UpdateShort:
		return sentMessageIDFromUpdates([]tg.UpdateClass{u.Update})
	default:
		return 0
	}
}

func sentMessageIDFromUpdates(updates []tg.UpdateClass) int {
	for _, update := range updates {
		switch u := update.(type) {
		case *tg.UpdateMessageID:
			return u.ID
		case *tg.UpdateNewMessage:
			if msg, ok := u.Message.(*tg.Message); ok {
				return msg.ID
			}
		case *tg.UpdateNewChannelMessage:
			if msg, ok := u.Message.(*tg.Message); ok {
				return msg.ID
			}
		}
	}
	return 0
}

func createTopic(ctx context.Context, api *tg.Client, peer peers.Peer, title string) (int, error) {
	updates, err := api.MessagesCreateForumTopic(ctx, &tg.MessagesCreateForumTopicRequest{
		Peer:     peer.InputPeer(),
		Title:    title,
		RandomID: time.Now().UnixNano(),
	})
	if err != nil {
		return 0, err
	}
	topicID := extractTopicID(updates)
	if topicID == 0 {
		return 0, fmt.Errorf("could not discover new topic id from updates")
	}
	return topicID, nil
}

// extractTopicID finds the topic creation service message in an Updates
// response. Its message ID is the forum topic ID.
func extractTopicID(updates tg.UpdatesClass) int {
	var list []tg.UpdateClass
	switch u := updates.(type) {
	case *tg.Updates:
		list = u.Updates
	case *tg.UpdatesCombined:
		list = u.Updates
	case *tg.UpdateShort:
		list = []tg.UpdateClass{u.Update}
	}
	for _, update := range list {
		switch u := update.(type) {
		case *tg.UpdateMessageID:
			return u.ID
		case *tg.UpdateNewMessage:
			if id := topicCreationMessageID(u.Message); id != 0 {
				return id
			}
		case *tg.UpdateNewChannelMessage:
			if id := topicCreationMessageID(u.Message); id != 0 {
				return id
			}
		}
	}
	return 0
}

func topicCreationMessageID(message tg.MessageClass) int {
	service, ok := message.(*tg.MessageService)
	if !ok {
		return 0
	}
	if _, ok := service.Action.(*tg.MessageActionTopicCreate); !ok {
		return 0
	}
	return service.ID
}
