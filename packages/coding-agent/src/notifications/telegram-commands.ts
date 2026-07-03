/** Telegram Bot API slash-command helpers shared by notification parsers. */
const TELEGRAM_BOT_USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;

export interface TelegramCommandTargetContext {
	/** Telegram chat type from message.chat.type. Undefined is treated like private for legacy tests/clients. */
	chatType?: string;
	/** Username returned by getMe for the paired bot, without a leading @. */
	botUsername?: string;
}

function isPrivateLikeChat(chatType: string | undefined): boolean {
	return chatType === undefined || chatType === "private";
}

/**
 * Normalize a Telegram slash-command token for this bot and chat type.
 *
 * Private chats may use `/cmd` (and `/cmd@ThisBot`). Group/supergroup/forum
 * chats must target this bot explicitly with `/cmd@ThisBot`; untargeted or
 * differently-targeted commands fail closed.
 */
export function normalizeTelegramCommandTokenForBot(
	token: string,
	ctx: TelegramCommandTargetContext = {},
): string | undefined {
	const at = token.indexOf("@");
	if (at === -1) return isPrivateLikeChat(ctx.chatType) ? token : undefined;

	const suffix = token.slice(at + 1);
	if (!TELEGRAM_BOT_USERNAME_RE.test(suffix)) return undefined;
	const botUsername = ctx.botUsername;
	if (!botUsername) return undefined;
	if (suffix.toLowerCase() !== botUsername.toLowerCase()) return undefined;
	return token.slice(0, at);
}
