import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function truncate(value: string, max = 2400): string {
	return value.length <= max ? value : `${value.slice(0, max)}\n… (${value.length - max} more chars)`;
}

export function extractMessageText(message: any): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

type ReviewConversationMessage = {
	role: "assistant" | "user";
	text: string;
};

type BranchConversationMessage = {
	role: ReviewConversationMessage["role"];
	text?: string;
};

type ReviewContext = {
	statedIntent?: string;
	recentConversation?: ReviewConversationMessage[];
};

// Best-effort context for the auto reviewer. Only the active session branch is
// considered. Every user/assistant message remains an ordering boundary, while
// text from the newest user and its adjacent assistant preserves approval context.
export function findReviewContext(ctx: ExtensionContext): ReviewContext {
	try {
		const messages: BranchConversationMessage[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const role = (entry as any).message?.role;
			if (role !== "assistant" && role !== "user") continue;
			const text = extractMessageText((entry as any).message);
			messages.push({ role, text: text ? truncate(text, 800) : undefined });
		}
		if (messages.length === 0) return {};

		let latestUserIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				latestUserIndex = i;
				break;
			}
		}

		const statedIntent = messages
			.slice(latestUserIndex + 1)
			.reverse()
			.find((message) => message.role === "assistant" && message.text)?.text
			?? (latestUserIndex >= 0 ? messages[latestUserIndex].text : messages.at(-1)?.text);

		if (latestUserIndex < 0) return { statedIntent };
		const latestUser = messages[latestUserIndex];
		if (!latestUser.text) return { statedIntent };

		const recentConversation: ReviewConversationMessage[] = [];
		const precedingMessage = messages[latestUserIndex - 1];
		if (precedingMessage?.role === "assistant" && precedingMessage.text) {
			recentConversation.push({ role: "assistant", text: precedingMessage.text });
		}
		recentConversation.push({ role: "user", text: latestUser.text });
		return { statedIntent, recentConversation };
	} catch {
		return {};
	}
}
