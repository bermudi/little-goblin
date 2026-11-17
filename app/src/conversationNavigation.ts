import { createRovingFocus, definePrimitive } from "@ui-sdk/core";

const conversationNavigation = definePrimitive({
	name: "conversation-navigation",
	options: { loop: "boolean" },
	state: (_options: { loop: boolean }) => ({ focused: null as string | null }),
	api: (context) => ({
		roving: createRovingFocus(context, {
			slot: "link",
			key: "focused",
			loop: () => context.options().loop,
		}),
	}),
	slots: (slot) => ({
		root: slot({ attrs: () => ({}) }),
		link: slot<{ id: string }>({
			props: { id: "key" },
			attrs: (state, part) => ({
				tabIndex: part.api.roving.tabIndex(state, part),
			}),
			on: {
				keydown: (event, { el, api }) => {
					if (el) api.roving.keydown(event, el);
				},
			},
			bind: (el, part) => part.api.roving.bind(el, part),
		}),
	}),
});

const conversationNavigationPrimitive = Object.assign(
	(options: Parameters<typeof conversationNavigation>[0]) => conversationNavigation(options),
	{
		options: conversationNavigation.options ?? {},
		slots: conversationNavigation.slots ?? {},
	},
);

export { conversationNavigationPrimitive };
