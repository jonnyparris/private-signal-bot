import { tool } from 'ai';
import { z } from 'zod';

const getLocalTime = tool({
	description: 'get the local time for a specified location',
	parameters: z.object({ location: z.string() }),
	execute: async ({ location }: { location: string }) => {
		console.log(`Getting local time for ${location}`);
		return '10am';
	},
});

const getFavouriteWord = tool({
	description: 'retrieves the favourite word every time',
	parameters: z.object({}),
	execute: async () => {
		console.log('Getting favourite word');
		return 'Dinkleberries!!!';
	},
});

const getSurfForecast = tool({
	description: 'get surf forecast for Costa da Caparica beach in Portugal',
	parameters: z.object({
		days: z.number().optional().describe('number of days to forecast (default: 3)'),
	}),
	execute: async ({ days = 3 }: { days?: number }) => {
		console.log(`Getting surf forecast for Costa da Caparica for ${days} days`);

		try {
			// Using Surfline API (free tier available)
			const spotId = '5842041f4e65fad6a7708e65';

			const response = await fetch(
				`https://services.surfline.com/kbyg/spots/forecasts/wave?spotId=${spotId}&days=${days}&intervalHours=3`,
				{
					headers: {
						'User-Agent': 'Mozilla/5.0 (compatible; AI-Worker/1.0)',
					},
				}
			);

			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`);
			}

			const data = await response.json();

			// Extract relevant forecast data
			const forecast = data.data.wave
				.map((wave: any, index: number) => ({
					timestamp: wave.timestamp,
					waveHeight: `${wave.surf.min}-${wave.surf.max}ft`,
					windSpeed: wave.wind?.speed || 'N/A',
					windDirection: wave.wind?.direction || 'N/A',
					conditions: wave.surf.humanRelation || 'Unknown',
				}))
				.slice(0, days * 8); // 8 intervals per day (3-hour intervals)

			return {
				location: 'Costa da Caparica, Portugal',
				forecast,
				summary: `${days}-day surf forecast with wave heights, wind conditions, and surf quality`,
			};
		} catch (error) {
			console.error('Error fetching surf forecast:', error);
			// Fallback response
			return {
				location: 'Costa da Caparica, Portugal',
				error: 'Unable to fetch live surf data',
				fallback: {
					waveHeight: '1-3ft',
					conditions: 'Fair',
					note: 'Static fallback data - check surf websites for current conditions',
				},
			};
		}
	},
});

const summarizeNews = tool({
	description: 'summarize latest news headlines from The Guardian and BBC',
	parameters: z.object({
		category: z.string().optional().describe('news category (e.g., world, politics, sport, technology)'),
		maxHeadlines: z.number().optional().describe('maximum number of headlines per source (default: 5)'),
	}),
	execute: async ({ category, maxHeadlines = 5 }: { category?: string; maxHeadlines?: number }) => {
		console.log(`Getting news headlines from Guardian and BBC${category ? ` for category: ${category}` : ''}`);

		try {
			const headlines: any[] = [];

			// Fetch Guardian headlines
			try {
				const guardianUrl = category
					? `https://content.guardianapis.com/search?section=${category}&show-fields=headline,trailText&page-size=${maxHeadlines}&api-key=test`
					: `https://content.guardianapis.com/search?show-fields=headline,trailText&page-size=${maxHeadlines}&api-key=test`;

				const guardianResponse = await fetch(guardianUrl);

				if (guardianResponse.ok) {
					const guardianData = await guardianResponse.json();
					const guardianHeadlines = guardianData.response.results.map((article: any) => ({
						source: 'The Guardian',
						headline: article.fields?.headline || article.webTitle,
						summary: article.fields?.trailText || '',
						url: article.webUrl,
						publishedDate: article.webPublicationDate,
					}));
					headlines.push(...guardianHeadlines);
				}
			} catch (guardianError) {
				console.error('Guardian API error:', guardianError);
			}

			// Fetch BBC headlines (using RSS as BBC API requires approval)
			try {
				const bbcRssUrl = category ? `https://feeds.bbci.co.uk/news/${category}/rss.xml` : 'https://feeds.bbci.co.uk/news/rss.xml';

				const bbcResponse = await fetch(bbcRssUrl);

				if (bbcResponse.ok) {
					const xmlText = await bbcResponse.text();

					// Simple XML parsing for RSS (in production, consider using a proper XML parser)
					const itemRegex = /<item>(.*?)<\/item>/gs;
					const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>/;
					const descRegex = /<description><!\[CDATA\[(.*?)\]\]><\/description>/;
					const linkRegex = /<link>(.*?)<\/link>/;
					const pubDateRegex = /<pubDate>(.*?)<\/pubDate>/;

					const items = xmlText.match(itemRegex) || [];
					const bbcHeadlines = items.slice(0, maxHeadlines).map((item) => {
						const title = item.match(titleRegex)?.[1] || 'No title';
						const description = item.match(descRegex)?.[1] || '';
						const link = item.match(linkRegex)?.[1] || '';
						const pubDate = item.match(pubDateRegex)?.[1] || '';

						return {
							source: 'BBC',
							headline: title,
							summary: description,
							url: link,
							publishedDate: pubDate,
						};
					});

					headlines.push(...bbcHeadlines);
				}
			} catch (bbcError) {
				console.error('BBC RSS error:', bbcError);
			}

			if (headlines.length === 0) {
				return {
					error: 'Unable to fetch news headlines',
					message: 'Both news sources are currently unavailable',
				};
			}

			// Sort by source and limit results
			const guardianHeadlines = headlines.filter((h) => h.source === 'The Guardian');
			const bbcHeadlines = headlines.filter((h) => h.source === 'BBC');

			return {
				category: category || 'general',
				totalHeadlines: headlines.length,
				sources: {
					guardian: {
						count: guardianHeadlines.length,
						headlines: guardianHeadlines,
					},
					bbc: {
						count: bbcHeadlines.length,
						headlines: bbcHeadlines,
					},
				},
				summary: `Retrieved ${headlines.length} headlines from The Guardian and BBC${category ? ` in ${category} category` : ''}`,
			};
		} catch (error) {
			console.error('Error fetching news:', error);
			return {
				error: 'Failed to fetch news headlines',
				message: 'Please try again later or check your internet connection',
			};
		}
	},
});

export const tools = {
	getLocalTime,
	getFavouriteWord,
	getSurfForecast,
	summarizeNews,
};
