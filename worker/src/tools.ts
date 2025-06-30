import { tool } from 'ai';
import { z } from 'zod';

// Environment interface for type safety
interface ToolsEnv {
	BRAVE_SEARCH_API_KEY?: string;
	OPENWEATHER_API_KEY?: string;
}

// Factory function to create tools with environment variables
export function createTools(env: ToolsEnv) {
	// Wikipedia search tool (prioritized - no API key needed, fast, reliable)
	const searchWikipedia = tool({
		description:
			'Search Wikipedia for factual information and summaries on any topic. PREFERRED for general knowledge, definitions, historical facts, biographies, scientific concepts, and educational content.',
		parameters: z.object({
			query: z.string().describe('Topic to search for on Wikipedia'),
			sentences: z.number().optional().describe('Number of sentences in summary (default: 2 for speed)'),
		}),
		execute: async ({ query, sentences = 2 }: { query: string; sentences?: number }) => {
			try {
				// Direct page lookup first (faster)
				const searchResponse = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);

				if (searchResponse.ok) {
					const data = await searchResponse.json();
					return formatWikipediaResult(data, query, sentences);
				}

				// Fallback search only if direct lookup fails
				const searchApiResponse = await fetch(
					`https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&origin=*`
				);

				if (searchApiResponse.ok) {
					const searchData = await searchApiResponse.json();
					if (searchData.query?.search?.length) {
						const pageTitle = searchData.query.search[0].title;
						const pageResponse = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`);

						if (pageResponse.ok) {
							const pageData = await pageResponse.json();
							return formatWikipediaResult(pageData, query, sentences);
						}
					}
				}

				return {
					query,
					error: 'No Wikipedia articles found',
					suggestion: 'Try a different search term or use web search for current events',
				};
			} catch (error) {
				return {
					query,
					error: 'Wikipedia temporarily unavailable',
					suggestion: 'Try web search instead',
				};
			}
		},
	});

	// Web search tool (fallback for current events, news, etc.)
	const webSearch = tool({
		description:
			'Search the web for CURRENT information, recent news, and topics not available on Wikipedia. Use sparingly to conserve API usage.',
		parameters: z.object({
			query: z.string().describe('Search query - be specific and include relevant keywords'),
			maxResults: z.number().optional().describe('Maximum number of results to return (default: 3 for speed)'),
		}),
		execute: async ({ query, maxResults = 3 }: { query: string; maxResults?: number }) => {
			try {
				// Try Brave Search API if available
				if (env.BRAVE_SEARCH_API_KEY) {
					const response = await fetch(
						`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
						{
							headers: {
								Accept: 'application/json',
								'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY,
							},
						}
					);

					if (response.ok) {
						const data = await response.json();

						if (data.web?.results?.length) {
							const results = data.web.results.slice(0, maxResults).map((result: any) => ({
								title: result.title,
								url: result.url,
								description: result.description,
							}));

							return {
								query,
								results,
								summary: `Found ${results.length} web results for "${query}"`,
								dataSource: 'Brave Search',
							};
						}
					}
				}

				// Fallback to DuckDuckGo
				return await fallbackSearch(query, maxResults);
			} catch (error) {
				return await fallbackSearch(query, maxResults);
			}
		},
	});

	// Hacker News tool for top voted articles in last 12 hours
	const getHackerNewsTop = tool({
		description: 'Get the top 10 voted Hacker News articles from the most recent 12-hour window',
		parameters: z.object({
			limit: z.number().optional().describe('Number of articles to return (default: 10, max: 20)'),
		}),
		execute: async ({ limit = 10 }: { limit?: number }) => {
			try {
				// Limit to max 20 for performance
				const maxLimit = Math.min(limit, 20);

				// Get recent story IDs (chronologically ordered)
				const response = await fetch('https://hacker-news.firebaseio.com/v0/newstories.json');
				if (!response.ok) {
					throw new Error('Failed to fetch Hacker News stories');
				}

				const storyIds = await response.json();

				// Calculate 12 hours ago in Unix seconds
				const twelveHoursAgo = Math.floor(Date.now() / 1000) - 12 * 60 * 60;

				const recentStories = [];

				// Fetch individual stories (check first 150 IDs for efficiency)
				for (let i = 0; i < Math.min(150, storyIds.length); i++) {
					try {
						const storyResponse = await fetch(`https://hacker-news.firebaseio.com/v0/item/${storyIds[i]}.json`);
						if (!storyResponse.ok) continue;

						const story = await storyResponse.json();

						// Stop if we've gone past our time window (stories are chronological)
						if (story.time < twelveHoursAgo) break;

						// Only include stories with score > 0 and valid data
						if (story && story.type === 'story' && story.score > 0 && story.title) {
							recentStories.push({
								id: story.id,
								title: story.title,
								url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
								score: story.score,
								author: story.by,
								time: story.time,
								timeAgo: formatTimeAgo(story.time),
								comments: story.descendants || 0,
								hnUrl: `https://news.ycombinator.com/item?id=${story.id}`,
							});
						}
					} catch (itemError) {
						// Skip individual item errors
						continue;
					}
				}

				// Sort by score descending and limit results
				const topStories = recentStories.sort((a, b) => b.score - a.score).slice(0, maxLimit);

				return {
					articles: topStories,
					totalFound: recentStories.length,
					timeWindow: '12 hours',
					summary: `Top ${topStories.length} Hacker News articles from the last 12 hours`,
					dataSource: 'Hacker News API',
					lastUpdated: new Date().toISOString(),
				};
			} catch (error) {
				return {
					error: 'Unable to fetch Hacker News articles',
					message: 'Hacker News API is currently unavailable',
					suggestion: 'Try again later or check https://news.ycombinator.com directly',
				};
			}
		},
	});

	// Weather tool (optimized)
	const getWeather = tool({
		description: 'Get current weather information for any location worldwide',
		parameters: z.object({
			location: z.string().describe('City name, or "current" for user location (Queluz, Lisbon)'),
		}),
		execute: async ({ location }: { location: string }) => {
			if (location.toLowerCase() === 'current') {
				location = 'Queluz, Lisbon, Portugal';
			}

			try {
				// Try OpenWeatherMap first if available
				if (env.OPENWEATHER_API_KEY) {
					const response = await fetch(
						`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${
							env.OPENWEATHER_API_KEY
						}&units=metric`
					);

					if (response.ok) {
						const data = await response.json();
						return {
							location: `${data.name}, ${data.sys.country}`,
							temperature: `${Math.round(data.main.temp)}°C`,
							description: data.weather[0].description,
							humidity: `${data.main.humidity}%`,
							windSpeed: `${data.wind.speed} m/s`,
							summary: `${Math.round(data.main.temp)}°C, ${data.weather[0].description} in ${data.name}`,
							dataSource: 'OpenWeatherMap',
						};
					}
				}

				// Fallback to free service
				return await fallbackWeather(location);
			} catch (error) {
				return await fallbackWeather(location);
			}
		},
	});

	// Translation tool (no API needed)
	const translateText = tool({
		description: 'Translate text between languages',
		parameters: z.object({
			text: z.string().describe('Text to translate'),
			targetLanguage: z.string().describe('Target language code (e.g., en, pt, es, fr, de)'),
			sourceLanguage: z.string().optional().describe('Source language code (auto-detect if not specified)'),
		}),
		execute: async ({ text, targetLanguage, sourceLanguage }: { text: string; targetLanguage: string; sourceLanguage?: string }) => {
			try {
				const requestBody: any = {
					q: text,
					target: targetLanguage,
					format: 'text',
				};

				if (sourceLanguage) {
					requestBody.source = sourceLanguage;
				}

				const response = await fetch('https://libretranslate.de/translate', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(requestBody),
				});

				if (response.ok) {
					const data = await response.json();
					return {
						originalText: text,
						translatedText: data.translatedText,
						sourceLanguage: sourceLanguage || 'auto',
						targetLanguage,
						dataSource: 'LibreTranslate',
					};
				}

				throw new Error('Translation failed');
			} catch (error) {
				return {
					originalText: text,
					error: 'Translation service unavailable',
					suggestion: 'Try again later',
				};
			}
		},
	});

	// Surf forecast tool (optimized)
	const getSurfForecast = tool({
		description: 'get surf forecast for any surf spot location (defaults to Costa da Caparica if no location provided)',
		parameters: z.object({
			location: z
				.string()
				.optional()
				.describe('surf spot location (e.g., "Costa da Caparica", "Ericeira", "Nazaré"). Defaults to Costa da Caparica'),
			days: z.number().optional().describe('number of days to forecast (default: 3)'),
		}),
		execute: async ({ location = 'Costa da Caparica', days = 3 }: { location?: string; days?: number }) => {
			const knownSpots = getKnownSurfSpots();
			const normalizedLocation = location.toLowerCase().trim();
			const knownSpot = knownSpots[normalizedLocation];

			if (knownSpot) {
				try {
					return await fetchSurfForecast(knownSpot.id, knownSpot.name, days);
				} catch (error) {
					// Silently fall through to search
				}
			}

			try {
				const spotId = await findSurfSpot(location);
				if (spotId) {
					return await fetchSurfForecast(spotId.id, spotId.name, days);
				}

				return {
					location,
					error: 'Surf spot not found',
					suggestion: `Try one of: ${Object.keys(knownSpots).join(', ')}`,
					knownLocations: Object.keys(knownSpots).join(', '),
				};
			} catch (error) {
				return {
					location,
					error: 'Surf data unavailable',
					suggestion: 'Try again later or check surf-forecast.com manually',
				};
			}
		},
	});

	// News tool (optimized)
	const summarizeNews = tool({
		description: 'summarize latest news headlines from The Guardian and BBC',
		parameters: z.object({
			category: z.string().optional().describe('news category (e.g., world, politics, sport, technology)'),
			maxHeadlines: z.number().optional().describe('maximum number of headlines per source (default: 3)'),
		}),
		execute: async ({ category, maxHeadlines = 3 }: { category?: string; maxHeadlines?: number }) => {
			try {
				const headlines: any[] = [];

				// Fetch Guardian headlines with timeout
				const guardianPromise = fetch(
					category
						? `https://content.guardianapis.com/search?section=${category}&show-fields=headline&page-size=${maxHeadlines}&api-key=test`
						: `https://content.guardianapis.com/search?show-fields=headline&page-size=${maxHeadlines}&api-key=test`,
					{ signal: AbortSignal.timeout(5000) }
				)
					.then(async (response) => {
						if (response.ok) {
							const data = await response.json();
							return data.response.results.map((article: any) => ({
								source: 'The Guardian',
								headline: article.fields?.headline || article.webTitle,
								url: article.webUrl,
							}));
						}
						return [];
					})
					.catch(() => []);

				const guardianHeadlines = await guardianPromise;
				headlines.push(...guardianHeadlines);

				return {
					category: category || 'general',
					totalHeadlines: headlines.length,
					headlines,
					summary: `Retrieved ${headlines.length} headlines from The Guardian${category ? ` in ${category} category` : ''}`,
				};
			} catch (error) {
				return {
					error: 'News service unavailable',
					message: 'Try again later',
				};
			}
		},
	});

	return {
		searchWikipedia, // Prioritized first
		webSearch, // Fallback for current events
		getHackerNewsTop, // NEW: Hacker News top articles
		getWeather,
		translateText,
		getSurfForecast,
		summarizeNews,
	};
}

// Helper function to format time ago
function formatTimeAgo(unixTimestamp: number): string {
	const now = Date.now() / 1000;
	const diffSeconds = now - unixTimestamp;
	const diffMinutes = Math.floor(diffSeconds / 60);
	const diffHours = Math.floor(diffMinutes / 60);

	if (diffHours < 1) {
		return `${diffMinutes}m ago`;
	} else if (diffHours < 24) {
		return `${diffHours}h ago`;
	} else {
		const diffDays = Math.floor(diffHours / 24);
		return `${diffDays}d ago`;
	}
}

// Fallback search using DuckDuckGo (simplified, less verbose)
async function fallbackSearch(query: string, maxResults: number) {
	try {
		const response = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);

		if (!response.ok) {
			throw new Error('Search unavailable');
		}

		const data = await response.json();
		const results = [];

		if (data.AbstractText) {
			results.push({
				title: data.Heading || 'Summary',
				description: data.AbstractText,
				url: data.AbstractURL,
				source: data.AbstractSource,
			});
		}

		if (data.RelatedTopics?.length) {
			data.RelatedTopics.slice(0, maxResults - 1).forEach((topic: any) => {
				if (topic.Text && topic.FirstURL) {
					results.push({
						title: topic.Text.split(' - ')[0],
						description: topic.Text,
						url: topic.FirstURL,
						source: 'DuckDuckGo',
					});
				}
			});
		}

		return {
			query,
			results,
			dataSource: 'DuckDuckGo',
			summary: `Found ${results.length} results`,
		};
	} catch (error) {
		return {
			query,
			error: 'Search unavailable',
			suggestion: 'Try again later',
		};
	}
}

// Fallback weather (simplified)
async function fallbackWeather(location: string) {
	try {
		const response = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);

		if (!response.ok) {
			throw new Error('Weather unavailable');
		}

		const data = await response.json();
		const current = data.current_condition[0];

		return {
			location,
			temperature: `${current.temp_C}°C`,
			description: current.weatherDesc[0].value,
			humidity: `${current.humidity}%`,
			windSpeed: `${current.windspeedKmph} km/h`,
			summary: `${current.temp_C}°C, ${current.weatherDesc[0].value} in ${location}`,
			dataSource: 'wttr.in',
		};
	} catch (error) {
		return {
			location,
			error: 'Weather unavailable',
			suggestion: 'Try again later',
		};
	}
}

function formatWikipediaResult(data: any, query: string, sentences: number) {
	let extract = data.extract || '';
	if (extract) {
		const sentenceArray = extract.split('. ');
		if (sentenceArray.length > sentences) {
			extract = sentenceArray.slice(0, sentences).join('. ') + '.';
		}
	}

	return {
		query,
		title: data.title,
		summary: extract,
		url: data.content_urls?.desktop?.page,
		dataSource: 'Wikipedia',
	};
}

// Surf forecast helpers (simplified, no verbose logging)
function getKnownSurfSpots() {
	return {
		'costa da caparica': { id: '5842041f4e65fad6a7708890', name: 'Costa da Caparica' },
		caparica: { id: '5842041f4e65fad6a7708890', name: 'Costa da Caparica' },
		ericeira: { id: '5842041f4e65fad6a7708876', name: 'Ericeira' },
		nazaré: { id: '5842041f4e65fad6a7708881', name: 'Nazaré' },
		peniche: { id: '5842041f4e65fad6a7708879', name: 'Peniche' },
		sagres: { id: '5842041f4e65fad6a7708888', name: 'Sagres' },
		carcavelos: { id: '5842041f4e65fad6a770888f', name: 'Carcavelos' },
	};
}

// Simplified surf spot search
async function findSurfSpot(location: string) {
	try {
		const response = await fetch(`https://services.surfline.com/kbyg/spots/search?q=${encodeURIComponent(location)}`, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
			},
		});

		if (response.ok) {
			const data = await response.json();
			if (data.data?.spots?.length > 0) {
				const spot = data.data.spots[0];
				return { id: spot._id, name: spot.name };
			}
		}
	} catch (error) {
		// Silent fallback
	}
	return null;
}

// Simplified surf forecast fetch
async function fetchSurfForecast(spotId: string, spotName: string, days: number) {
	try {
		const response = await fetch(`https://services.surfline.com/kbyg/spots/forecasts/wave?spotId=${spotId}&days=${days}&intervalHours=6`, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
			},
		});

		if (!response.ok) {
			throw new Error('Surf API unavailable');
		}

		const waveData = await response.json();

		// Simplified forecast (every 6 hours instead of 3)
		const forecast = waveData.data.wave
			.map((wave: any) => ({
				date: new Date(wave.timestamp * 1000).toLocaleDateString('en-GB'),
				time: new Date(wave.timestamp * 1000).toLocaleTimeString('en-GB', {
					hour: '2-digit',
					minute: '2-digit',
				}),
				waveHeight: `${(wave.surf.min * 0.3048).toFixed(1)}-${(wave.surf.max * 0.3048).toFixed(1)}m`,
				conditions: wave.surf.humanRelation || 'Unknown',
			}))
			.slice(0, days * 4); // 4 intervals per day (6-hour intervals)

		return {
			location: spotName,
			forecast,
			dataSource: 'Surfline',
			summary: `${days}-day surf forecast for ${spotName}`,
		};
	} catch (error) {
		throw new Error('Failed to fetch surf forecast');
	}
}

// For backward compatibility, export the old format
export const tools = createTools({});
