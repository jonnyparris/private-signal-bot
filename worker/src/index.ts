import { Agent, getAgentByName, routeAgentRequest, type AgentNamespace } from 'agents';
import { runWithTools } from '@cloudflare/ai-utils';
import { tools } from './tools';
import { env } from 'cloudflare:workers';

type Env = {
	AI: Ai;
	Ziggy: AgentNamespace<Ziggy>;
};
interface MyState {
	// Define any state properties you need for your Agent
}
export class Ziggy extends Agent<Env, MyState> {
	async onRequest(request: Request): Promise<Response> {
		if (request.method === 'POST') {
			try {
				const { prompt } = (await request.json()) as any;
				const response = await this.respond(prompt);
				return new Response(JSON.stringify(response), {
					headers: { 'Content-Type': 'application/json' },
				});
			} catch (error) {
				console.error('Error in /signal-bot:', error);
				return new Response('Internal Server Error', { status: 500 });
			}
		}
		return new Response('Not Found', { status: 404 });
	}

	async respond(prompt: string): Promise<any> {
		try {
			// const mcpConnection = await this.mcp.connect(
			//   "https://path-to-mcp-server/sse"
			// );

			const response = await runWithTools(env.AI as any, '@cf/mistralai/mistral-small-3.1-24b-instruct', {
				messages: [
					{
						role: 'system',
						content:
							"You are a highly capable, thoughtful, and precise assistant. You are a Signal bot that responds to messages in a concise, helpful and friendly manner, using emojis where appropriate. You are always upfront about your limitations, and you never make up information. Always prioritize being truthful, nuanced, insightful, and efficient, tailoring your responses specifically to the user's needs and preferences. Feel free to use your available tools to provide live or interesting responses.",
					},
					{ role: 'user', content: prompt },
				],
				tools,
			});
			console.log('AI response received:', JSON.stringify(response, null, 2));
			return response;
		} catch (error: any) {
			console.error('Error processing ai response:', error);
			throw new Error('Failed to process response');
		}
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/signal-bot') {
			let namedAgent = getAgentByName<Env, Ziggy>(env.Ziggy, 'ziggy-bot');
			let namedResp = (await namedAgent).fetch(request);
			return namedResp;
		} else {
			console.log('url.pathname:', url.pathname);
			return (await routeAgentRequest(request, env)) || Response.json({ msg: 'no agent here' }, { status: 404 });
		}
	},
} satisfies ExportedHandler<Env>;
