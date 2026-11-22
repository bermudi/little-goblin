import { z } from "zod";
import { defineTool } from "../../tool.ts";
import { POST_MAX_CHARS, type Posts } from "../../posts.ts";

const schema = z.object({
	text: z.string().min(1).max(POST_MAX_CHARS),
}).strict();

export interface PostToolDeps {
	posts: Pick<Posts, "add">;
	conversationId: string;
}

export function postTool(deps: PostToolDeps) {
	return defineTool({
		description: `Post a short update to the operator's feed: the Activity tab of the Goblin panel in the app. The post shows there with its time. It does not notify the operator or send a message; they see it when they look. Plain text, at most ${POST_MAX_CHARS} characters. Posts cannot be edited or removed.`,
		input: schema,
		execute: (input) => {
			const text = schema.parse(input).text.trim();
			if (text === "") return { error: "a post needs text" };
			const post = deps.posts.add({ conversationId: deps.conversationId, text });
			return { id: post.id, createdAt: post.createdAt };
		},
	});
}
