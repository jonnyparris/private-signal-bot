import { Agent, getAgentByName, routeAgentRequest, type AgentNamespace } from 'agents';
import { createTools } from './tools'; // Import the factory function
import { createAiGateway } from 'ai-gateway-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, experimental_createMCPClient } from 'ai';

type Env = {
	GW_TOKEN: string;
	AI: Ai;
	Ziggy: AgentNamespace<Ziggy>;
	// MCP server environment variables
	DOCS_VECTORIZE_MCP_URL?: string;
	// Authentication tokens for MCP servers
	DOCS_VECTORIZE_MCP_TOKEN?: string;
	MCP_AUTH_TOKEN?: string;
	// API keys for tools
	BRAVE_SEARCH_API_KEY?: string;
	OPENWEATHER_API_KEY?: string;
};

interface MyState {
	// Define any state properties you need for your Agent
}

interface MCPClientInfo {
	client: any;
	lastUsed: number;
	isHealthy: boolean;
}

interface MCPClients {
	docsVectorize?: MCPClientInfo;
}

export class Ziggy extends Agent<Env, MyState> {
	private mcpClients: MCPClients = {};
	private mcpToolsCache: any = {};
	private toolsCacheExpiry: number = 0;
	private readonly CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
	private readonly CONNECTION_TIMEOUT_MS = 10000; // 10 seconds

	async onRequest(request: Request): Promise<Response> {
		if (request.method === 'POST') {
			try {
				const { prompt } = (await request.json()) as any;

				if (!prompt || typeof prompt !== 'string') {
					return new Response(JSON.stringify({ error: 'Invalid prompt' }), {
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					});
				}

				const response = await this.respond(prompt);
				return new Response(JSON.stringify(response), {
					headers: { 'Content-Type': 'application/json' },
				});
			} catch (error) {
				console.error('Error in /signal-bot:', error);
				return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' },
				});
			}
		}
		return new Response('Not Found', { status: 404 });
	}

	async respond(prompt: string): Promise<any> {
		try {
			// Initialize MCP clients with timeout
			await Promise.race([
				this.initializeMCPClients(),
				new Promise((_, reject) => setTimeout(() => reject(new Error('MCP initialization timeout')), this.CONNECTION_TIMEOUT_MS)),
			]);

			// Get MCP tools with caching
			const mcpTools = await this.getMCPToolsCached();

			// Create tools with environment variables
			const localTools = createTools({
				BRAVE_SEARCH_API_KEY: this.env.BRAVE_SEARCH_API_KEY,
				OPENWEATHER_API_KEY: this.env.OPENWEATHER_API_KEY,
			});

			const aigateway = createAiGateway({
				accountId: '4b430e167a301330d13a9bb42f3986a2',
				apiKey: this.env.GW_TOKEN,
				gateway: 'cheese',
				options: {
					skipCache: true,
				},
			});

			const openai = createOpenAI({ apiKey: '' });
			const gemini = createGoogleGenerativeAI({ apiKey: '' });

			const model = aigateway([gemini('gemini-2.5-pro-preview-03-25'), openai('gpt-4o-mini')]);

			// Combine tools safely
			const allTools = this.combineToolsSafely(localTools, mcpTools);

			const { text } = await generateText({
				model,
				messages: [
					{
						role: 'system',
						content: this.getSystemPrompt(Object.keys(mcpTools)),
					},
					{ role: 'user', content: prompt },
				],
				tools: allTools,
				maxSteps: 5, // Reduced from 10 for speed
			});

			return { response: text };
		} catch (error: any) {
			console.error('Error processing AI response:', error);

			// Provide fallback response without MCP tools
			try {
				const fallbackResponse = await this.getFallbackResponse(prompt);
				return {
					response: fallbackResponse,
					warning: 'Some advanced features may be unavailable',
				};
			} catch (fallbackError) {
				console.error('Fallback response also failed:', fallbackError);
				throw new Error('Failed to process response');
			}
		} finally {
			// Don't cleanup connections immediately - reuse them
			this.scheduleConnectionCleanup();
		}
	}

	private getSystemPrompt(mcpToolNames: string[]): string {
		const basePrompt =
			'You are a highly capable, thoughtful, and precise assistant. You are a Signal bot that responds to messages in a concise, helpful and friendly manner, using emojis where appropriate.';

		const availableCapabilities = [];
		if (mcpToolNames.some((name) => name.includes('docs'))) {
			availableCapabilities.push('Cloudflare documentation search');
		}

		// Add information about tool preferences
		const toolCapabilities = [
			'Wikipedia search (PREFERRED for factual information)',
			'web search (for current events only)',
			'weather information',
			'text translation',
			'surf forecasts',
			'news summaries',
		];
		availableCapabilities.push(...toolCapabilities);

		const capabilitiesText = availableCapabilities.length > 0 ? ` You have access to: ${availableCapabilities.join(', ')}.` : '';

		return `${basePrompt}${capabilitiesText}

IMPORTANT: Always prefer Wikipedia for general knowledge, definitions, historical facts, biographies, and educational content. Only use web search for current events, breaking news, or very recent information not available on Wikipedia.

You are always upfront about your limitations, and you never make up information. Always prioritize being truthful, nuanced, insightful, and efficient, tailoring your responses specifically to the user's needs and preferences.`;
	}

	private async getFallbackResponse(prompt: string): Promise<string> {
		const aigateway = createAiGateway({
			accountId: '4b430e167a301330d13a9bb42f3986a2',
			apiKey: this.env.GW_TOKEN,
			gateway: 'cheese',
			options: { skipCache: true },
		});

		const gemini = createGoogleGenerativeAI({ apiKey: '' });
		const model = aigateway([gemini('gemini-2.5-pro-preview-03-25')]);

		// Create tools without API keys for fallback
		const fallbackTools = createTools({});

		const { text } = await generateText({
			model,
			messages: [
				{
					role: 'system',
					content:
						"You are a highly capable, thoughtful, and precise assistant. You are a Signal bot that responds to messages in a concise, helpful and friendly manner, using emojis where appropriate. You are always upfront about your limitations, and you never make up information. Always prioritize being truthful, nuanced, insightful, and efficient, tailoring your responses specifically to the user's needs and preferences. Feel free to use your available tools to provide live or interesting responses.",
				},
				{ role: 'user', content: prompt },
			],
			tools: fallbackTools,
			maxSteps: 5,
		});

		return text;
	}

	// ... rest of your existing MCP methods remain unchanged
	private combineToolsSafely(localTools: any, mcpTools: any): any {
		try {
			const combinedTools = { ...localTools };

			if (mcpTools && typeof mcpTools === 'object') {
				for (const [toolName, toolConfig] of Object.entries(mcpTools)) {
					if (this.isValidToolConfig(toolConfig)) {
						combinedTools[toolName] = toolConfig;
					} else {
						console.warn(`Skipping invalid MCP tool: ${toolName}`);
					}
				}
			}

			return combinedTools;
		} catch (error) {
			console.error('Error combining tools, using local tools only:', error);
			return localTools;
		}
	}

	private async getMCPToolsCached(): Promise<any> {
		const now = Date.now();

		// Return cached tools if still valid
		if (now < this.toolsCacheExpiry && Object.keys(this.mcpToolsCache).length > 0) {
			return this.mcpToolsCache;
		}

		// Refresh tools cache
		try {
			const freshTools = await this.getMCPTools();
			this.mcpToolsCache = freshTools;
			this.toolsCacheExpiry = now + this.CACHE_DURATION_MS;
			return freshTools;
		} catch (error) {
			// Return cached version even if expired, better than nothing
			return this.mcpToolsCache;
		}
	}

	private async initializeMCPClients(): Promise<void> {
		console.log('Initializing MCP clients...');
		console.log('DOCS_VECTORIZE_MCP_URL:', this.env.DOCS_VECTORIZE_MCP_URL ? 'Present' : 'Missing');

		const initPromises: Promise<void>[] = [];

		// Initialize Docs Vectorize MCP client
		if (this.env.DOCS_VECTORIZE_MCP_URL && !this.isClientHealthy('docsVectorize')) {
			initPromises.push(this.initializeDocsClient());
		} else if (!this.env.DOCS_VECTORIZE_MCP_URL) {
			console.log('DOCS_VECTORIZE_MCP_URL not configured');
		} else {
			console.log('Docs client already healthy, skipping initialization');
		}

		// Wait for all connections with individual error handling
		const results = await Promise.allSettled(initPromises);
		console.log('MCP client initialization results:', results);
	}

	private async initializeDocsClient(): Promise<void> {
		try {
			console.log('Attempting to connect to docs MCP server:', this.env.DOCS_VECTORIZE_MCP_URL);

			const authToken = this.env.DOCS_VECTORIZE_MCP_TOKEN || this.env.MCP_AUTH_TOKEN;
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				'User-Agent': 'Ziggy-Agent/1.0.0',
			};

			if (authToken) {
				headers['Authorization'] = `Bearer ${authToken}`;
				console.log('Using auth token for docs MCP client');
			} else {
				console.log('No auth token available for docs MCP client');
			}

			const client = await experimental_createMCPClient({
				transport: {
					type: 'sse',
					url: this.env.DOCS_VECTORIZE_MCP_URL!,
					headers,
				},
				name: 'ziggy-docs-client',
			});

			this.mcpClients.docsVectorize = {
				client,
				lastUsed: Date.now(),
				isHealthy: true,
			};

			console.log('✅ Connected to Docs Vectorize MCP server');
		} catch (error) {
			console.error('❌ Failed to connect to Docs Vectorize MCP server:', error);
			if (this.mcpClients.docsVectorize) {
				this.mcpClients.docsVectorize.isHealthy = false;
			}
		}
	}

	private isClientHealthy(clientType: keyof MCPClients): boolean {
		const client = this.mcpClients[clientType];
		if (!client) return false;

		const now = Date.now();
		const timeSinceLastUse = now - client.lastUsed;

		// Consider connection stale if not used for more than 30 minutes
		const isStale = timeSinceLastUse > 30 * 60 * 1000;

		return client.isHealthy && !isStale;
	}

	private async getMCPTools(): Promise<any> {
		const mcpTools: any = {};

		// Get tools from docs client only
		await Promise.allSettled([this.getToolsFromClient('docsVectorize', 'docs', mcpTools)]);

		console.log('Available MCP tools:', Object.keys(mcpTools));
		return mcpTools;
	}

	private async getToolsFromClient(clientType: keyof MCPClients, toolPrefix: string, mcpTools: any): Promise<void> {
		const clientInfo = this.mcpClients[clientType];

		if (!clientInfo || !clientInfo.isHealthy) {
			console.log(`Skipping ${clientType} - client not available`);
			return;
		}

		try {
			console.log(`Getting tools from ${clientType} client...`);
			// Use the AI SDK MCP client to get tools
			const tools = await clientInfo.client.tools();
			clientInfo.lastUsed = Date.now();

			console.log(`Raw tools from ${clientType}:`, Object.keys(tools));

			// Convert AI SDK MCP tools to our internal format
			for (const [toolName, toolConfig] of Object.entries(tools)) {
				try {
					const prefixedToolName = `${toolPrefix}_${toolName}`;
					console.log(`Processing tool: ${toolName} -> ${prefixedToolName}`);

					mcpTools[prefixedToolName] = {
						description: `[${toolPrefix.toUpperCase()}] ${toolConfig.description || 'No description'}`,
						parameters: toolConfig.parameters || {
							type: 'object',
							properties: {},
							additionalProperties: false,
						},
						execute: async (params: any) => {
							return await this.executeMCPTool(clientType, toolName, toolConfig, params);
						},
					};

					console.log(`Added tool: ${prefixedToolName} with description: ${toolConfig.description}`);
				} catch (toolError) {
					console.error(`Error processing tool ${toolName}:`, toolError);
				}
			}
		} catch (error) {
			console.error(`Error getting tools from ${clientType}:`, error);
			clientInfo.isHealthy = false;
		}
	}

	private async executeMCPTool(clientType: keyof MCPClients, toolName: string, toolConfig: any, params: any): Promise<string> {
		const clientInfo = this.mcpClients[clientType];

		if (!clientInfo || !clientInfo.isHealthy) {
			return `Error: ${clientType} client not available`;
		}

		try {
			console.log(`Executing ${clientType}:${toolName} with params:`, params);

			// Execute the tool using the AI SDK MCP client
			const result = await toolConfig.execute(params || {});

			clientInfo.lastUsed = Date.now();

			const formattedResult = this.formatMCPResponse(result);
			console.log(`${clientType}:${toolName} completed successfully`);

			return formattedResult;
		} catch (error) {
			console.error(`Error executing ${clientType}:${toolName}:`, error);
			clientInfo.isHealthy = false;

			return `Error: Failed to execute ${toolName} - ${error instanceof Error ? error.message : 'Unknown error'}`;
		}
	}

	private formatMCPResponse(result: any): string {
		try {
			if (!result) return 'No result returned';

			// Handle string responses
			if (typeof result === 'string') return result;

			// Handle structured responses
			if (typeof result === 'object') {
				// If it has a specific format, extract relevant data
				if (result.content) {
					if (Array.isArray(result.content)) {
						return result.content
							.map((item) => {
								if (typeof item === 'string') return item;
								if (item?.type === 'text' && item?.text) return item.text;
								if (item?.type === 'image') return `[Image data received]`;
								return JSON.stringify(item);
							})
							.join('\n');
					}

					if (typeof result.content === 'string') return result.content;
					return JSON.stringify(result.content, null, 2);
				}

				return JSON.stringify(result, null, 2);
			}

			return String(result);
		} catch (error) {
			console.error('Error formatting MCP response:', error);
			return `Error formatting response: ${error instanceof Error ? error.message : 'Unknown error'}`;
		}
	}

	private isValidToolConfig(toolConfig: any): boolean {
		return !!(
			toolConfig &&
			typeof toolConfig === 'object' &&
			typeof toolConfig.description === 'string' &&
			typeof toolConfig.parameters === 'object' &&
			typeof toolConfig.execute === 'function'
		);
	}

	private scheduleConnectionCleanup(): void {
		// Schedule cleanup for idle connections after 5 minutes
		setTimeout(() => {
			this.cleanupIdleConnections();
		}, 5 * 60 * 1000);
	}

	private async cleanupIdleConnections(): Promise<void> {
		const now = Date.now();
		const idleThreshold = 10 * 60 * 1000; // 10 minutes

		for (const [key, clientInfo] of Object.entries(this.mcpClients)) {
			if (clientInfo && now - clientInfo.lastUsed > idleThreshold) {
				try {
					await clientInfo.client.close();
					delete this.mcpClients[key as keyof MCPClients];
					console.log(`Cleaned up idle ${key} client`);
				} catch (error) {
					console.error(`Error cleaning up ${key} client:`, error);
				}
			}
		}
	}

	private async cleanupAllConnections(): Promise<void> {
		const cleanupPromises = Object.entries(this.mcpClients).map(async ([key, clientInfo]) => {
			if (clientInfo) {
				try {
					await clientInfo.client.close();
				} catch (error) {
					console.error(`Error closing ${key} client:`, error);
				}
			}
		});

		await Promise.allSettled(cleanupPromises);
		this.mcpClients = {};
		this.mcpToolsCache = {};
		this.toolsCacheExpiry = 0;
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
