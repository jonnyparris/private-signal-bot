import { DurableObject } from 'cloudflare:workers';
import { runWithTools } from '@cloudflare/ai-utils';
import { tools } from './tools';

/** A Durable Object's behavior is defined in an exported Javascript class */
export class ZiggyDO extends DurableObject<Env> {
	/**
	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
	 * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
	 *
	 * @param ctx - The interface for interacting with Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async respond(prompt: string): Promise<any> {
		try {
			// const mcpConnection = await this.mcp.connect(
			//   "https://path-to-mcp-server/sse"
			// );

			// Collect all tools, including MCP tools
			const allToolsArray = Object.values(tools);
			console.info('allToolsArray:', allToolsArray);
			// If you need to merge with other tools, use: [...Object.values(tools), ...otherTools]

			const response = await runWithTools(this.env.AI, '@cf/meta/llama-4-scout-17b-16e-instruct', {
				messages: [
					{
						role: 'system',
						content:
							"You are a highly capable, thoughtful, and precise assistant. You are a Signal bot that responds to messages in a concise, helpful and friendly manner, using emojis where appropriate. You are always upfront about your limitations, and you never make up information. Always prioritize being truthful, nuanced, insightful, and efficient, tailoring your responses specifically to the user's needs and preferences.",
					},
					{ role: 'user', content: prompt },
				],
				tools: [],
				// tools: allToolsArray,
			});

			return response;
		} catch (error) {
			console.error('Error processing ai response:', error);
			throw new Error('Failed to process response');
		}
	}
}

export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 * @param ctx - The execution context of the Worker
	 * @returns The response to be sent back to the client
	 */
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/signal-bot') {
			try {
				const id: DurableObjectId = env.ZIGGY_DO.idFromName('ziggy-bot');
				const stub = env.ZIGGY_DO.get(id);

				const { prompt } = (await request.json()) as any;
				const response = await stub.respond(prompt);
				return new Response(JSON.stringify(response), {
					headers: { 'Content-Type': 'application/json' },
				});
			} catch (error) {
				console.error('Error in /signal-bot:', error);
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
