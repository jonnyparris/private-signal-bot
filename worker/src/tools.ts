// tools.ts - Cloudflare Workers AI compatible format
import type { AiTextGenerationToolInputWithFunction } from '@cloudflare/ai-utils';

export const tools: AiTextGenerationToolInputWithFunction[] = [
	{
		name: 'getLocalTime',
		description: 'get the local time for a specified location',
		parameters: {
			type: 'object' as const,
			properties: {
				location: {
					type: 'string',
					description: 'The location to get the time for',
				},
			},
			required: ['location'],
		},
		function: async ({ location }: { location: string }) => {
			console.log(`Getting local time for ${location}`);
			return '10am';
		},
	},
	{
		name: 'getFavouriteWord',
		description:
			'Get my favorite word when the user asks about favorite words, fun words, silly words, or wants to know what word I like best',
		function: async () => {
			console.log(`Getting favourite word`);
			return 'Dinkleberries!!!';
		},
	},
];
