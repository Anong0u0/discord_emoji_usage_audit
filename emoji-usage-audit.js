import 'dotenv/config';
import { REST, RESTEvents } from '@discordjs/rest';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';

const CONFIG = {
  token: process.env.DISCORD_BOT_TOKEN ?? '',
  guildId: process.env.DISCORD_GUILD_ID ?? '',

  // API / runtime
  apiVersion: '9',
  concurrency: 4,
  maxRequestRetries: 6,
  retryBaseMs: 750,
  indexRetryCapMs: 15_000,
  logRateLimits: true,
  maxEmojis: null, // null = audit all filtered emojis

  // Emoji filters (null = no filter)
  filterAnimated: null,   // true => only animated, false => only static
  filterAvailable: null,  // true => only available, false => only unavailable
  filterManaged: null,    // true => only managed, false => only unmanaged

  // Optional allow/deny lists
  onlyEmojiNames: null,   // e.g. ['laugh', 'cry']
  skipEmojiNames: [],

  // Output
  outputDir: './out',
  outputCsvName: 'emoji-usage-report.csv',
  outputJsonName: 'emoji-usage-report.json',

  // CSV content
  excerptLength: 120,
};

const rest = new REST({ version: CONFIG.apiVersion }).setToken(CONFIG.token);

rest.on(RESTEvents.RateLimited, (info) => {
  if (!CONFIG.logRateLimits) return;
  console.warn(
    `[rate-limit] scope=${info.scope} global=${info.global} method=${info.method} route=${info.route} retryAfterMs=${info.retryAfter}`,
  );
});

function assertConfig() {
  const missing = [];
  if (!CONFIG.token) missing.push('DISCORD_BOT_TOKEN');
  if (!CONFIG.guildId) missing.push('DISCORD_GUILD_ID');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now() {
  return new Date();
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : '';
}

function toCsvValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function excerpt(text, maxLength = CONFIG.excerptLength) {
  if (!text) return '';
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function daysBetween(earlier, later = now()) {
  const a = toDate(earlier);
  const b = toDate(later);
  if (!a || !b) return null;
  return Number(((b.getTime() - a.getTime()) / 86_400_000).toFixed(2));
}

function snowflakeToDate(snowflake) {
  if (!snowflake) return null;
  const discordEpoch = 1_420_070_400_000n;
  const ms = Number((BigInt(String(snowflake)) >> 22n) + discordEpoch);
  return new Date(ms);
}

function buildMessageUrl(guildId, channelId, messageId) {
  if (!guildId || !channelId || !messageId) return '';
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function buildEmojiSearchKeyword(emoji) {
  const animatedPrefix = emoji.animated ? 'a' : '';
  return `<${animatedPrefix}:${emoji.name}:${emoji.id}>`;
}

function buildLatestSearchRoute(emoji) {
  const params = new URLSearchParams({
    content: buildEmojiSearchKeyword(emoji),
    sort_by: 'timestamp',
    sort_order: 'desc',
    offset: '0',
  });
  return `/guilds/${CONFIG.guildId}/messages/search?${params.toString()}`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function messageContainsEmoji(message, emoji) {
  if (!message?.content) return false;
  const pattern = new RegExp(`<a?:${escapeRegex(emoji.name)}:${escapeRegex(emoji.id)}>`);
  return pattern.test(String(message.content));
}

function findLatestMatchingMessage(messages, emoji) {
  if (!Array.isArray(messages)) return null;

  for (const bucket of messages) {
    if (!Array.isArray(bucket)) continue;

    for (const message of bucket) {
      if (messageContainsEmoji(message, emoji)) {
        return message;
      }
    }
  }

  return null;
}

function summarizeMessage(message) {
  if (!message) {
    return {
      messageId: '',
      channelId: '',
      authorId: '',
      authorUsername: '',
      authorGlobalName: '',
      timestamp: '',
      contentExcerpt: '',
      url: '',
    };
  }

  return {
    messageId: String(message.id ?? ''),
    channelId: String(message.channel_id ?? ''),
    authorId: String(message.author?.id ?? ''),
    authorUsername: String(message.author?.username ?? ''),
    authorGlobalName: String(message.author?.global_name ?? ''),
    timestamp: toIso(message.timestamp),
    contentExcerpt: excerpt(message.content ?? ''),
    url: buildMessageUrl(CONFIG.guildId, message.channel_id, message.id),
  };
}

function normalizeDiscordError(error) {
  if (!error || typeof error !== 'object') return null;
  return {
    name: error.name,
    message: error.message,
    status: error.status ?? error.code ?? null,
    method: error.method ?? null,
    url: error.url ?? null,
    rawError: error.rawError ?? null,
  };
}

async function apiGet(route) {
  let attempt = 0;

  while (true) {
    try {
      const result = await rest.get(route);

      if (
        result &&
        typeof result === 'object' &&
        'code' in result &&
        Number(result.code) === 110000
      ) {
        const retryAfterSeconds = Number(result.retry_after ?? 0);
        const waitMs = Math.min(
          Math.max(250, Math.ceil(retryAfterSeconds * 1000) + Math.floor(Math.random() * 250)),
          CONFIG.indexRetryCapMs,
        );
        console.warn(`[indexing] ${route} not ready yet; retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      return result;
    } catch (error) {
      const normalized = normalizeDiscordError(error);
      const status = Number(normalized?.status ?? 0);
      const retriable = [500, 502, 503, 504].includes(status) || /ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(error?.message ?? ''));

      if (!retriable || attempt >= CONFIG.maxRequestRetries) {
        throw error;
      }

      const waitMs = CONFIG.retryBaseMs * (2 ** attempt) + Math.floor(Math.random() * 250);
      console.warn(`[retry] ${route} failed with status=${status || 'unknown'}; retrying in ${waitMs}ms`);
      attempt += 1;
      await sleep(waitMs);
    }
  }
}

async function getGuildEmojis(guildId) {
  const route = `/guilds/${guildId}/emojis`;
  const result = await apiGet(route);
  if (!Array.isArray(result)) {
    throw new Error(`Unexpected emoji response shape from ${route}`);
  }
  return result;
}

function filterEmojis(emojis) {
  const onlySet = CONFIG.onlyEmojiNames ? new Set(CONFIG.onlyEmojiNames) : null;
  const skipSet = new Set(CONFIG.skipEmojiNames ?? []);

  return emojis.filter((emoji) => {
    if (CONFIG.filterAnimated !== null && Boolean(emoji.animated) !== CONFIG.filterAnimated) return false;
    if (CONFIG.filterAvailable !== null && Boolean(emoji.available) !== CONFIG.filterAvailable) return false;
    if (CONFIG.filterManaged !== null && Boolean(emoji.managed) !== CONFIG.filterManaged) return false;
    if (onlySet && !onlySet.has(emoji.name)) return false;
    if (skipSet.has(emoji.name)) return false;
    return true;
  });
}

async function searchEmojiLatest(emoji) {
  return apiGet(buildLatestSearchRoute(emoji));
}

function numberOrZero(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function auditEmoji(emoji) {
  const createdAt = snowflakeToDate(emoji.id);
  const latestResponse = await searchEmojiLatest(emoji);
  const latestMessage = findLatestMatchingMessage(latestResponse.messages, emoji);
  const totalResults = latestMessage ? numberOrZero(latestResponse.total_results) : 0;
  const latest = summarizeMessage(latestMessage);
  const lastUseDate = latest.timestamp || '';
  const emojiAgeDays = daysBetween(createdAt);
  const lastUseAgeDays = daysBetween(lastUseDate);
  const daysSinceEmojiCreation = daysBetween(createdAt);
  const usesPer30dSinceCreation = daysSinceEmojiCreation && daysSinceEmojiCreation > 0
    ? Number(((totalResults / daysSinceEmojiCreation) * 30).toFixed(3))
    : 0;

  const row = {
    emoji_id: String(emoji.id),
    emoji_name: String(emoji.name),
    emoji_query: buildEmojiSearchKeyword(emoji),
    animated: Boolean(emoji.animated),
    available: Boolean(emoji.available),
    managed: Boolean(emoji.managed),
    emoji_created_at: toIso(createdAt),
    emoji_age_days: emojiAgeDays ?? '',
    last_used_at: lastUseDate,
    days_since_last_use: lastUseAgeDays ?? '',
    total_results: totalResults,
    uses_per_30d_since_creation: usesPer30dSinceCreation,
    latest_message_url: latest.url,
    latest_content_excerpt: latest.contentExcerpt,
  };

  return row;
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const aDays = a.days_since_last_use === '' ? -1 : Number(a.days_since_last_use);
    const bDays = b.days_since_last_use === '' ? -1 : Number(b.days_since_last_use);
    if (aDays !== bDays) return bDays - aDays;

    if (a.total_results !== b.total_results) return a.total_results - b.total_results;
    return a.emoji_name.localeCompare(b.emoji_name);
  });
}

function limitItems(items, maxItems) {
  if (maxItems === null || maxItems === undefined) return items;
  const limit = Number(maxItems);
  if (!Number.isFinite(limit) || limit < 0) return items;
  return items.slice(0, limit);
}

async function writeCsv(rows, filePath) {
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const lines = [headers.join(',')];

  for (const row of rows) {
    lines.push(headers.map((header) => toCsvValue(row[header])).join(','));
  }

  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function writeJson(rows, filePath) {
  await writeFile(filePath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

function summarizeRun(rows) {
  const available = rows.filter((row) => row.available).length;
  const unavailable = rows.length - available;
  const animated = rows.filter((row) => row.animated).length;
  const staticEmoji = rows.length - animated;

  console.log('');
  console.log('Summary');
  console.log('-------');
  console.log(`Rows: ${rows.length}`);
  console.log(`Available: ${available}`);
  console.log(`Unavailable: ${unavailable}`);
  console.log(`Animated: ${animated}`);
  console.log(`Static: ${staticEmoji}`);

  console.log('');
  console.log('Top 10 candidates to review first:');
  for (const row of rows.slice(0, 10)) {
    console.log(
      `- ${row.emoji_name} | total=${row.total_results} | lastUsed=${row.last_used_at || 'never'} | available=${row.available} | animated=${row.animated}`,
    );
  }
}

async function main() {
  assertConfig();

  console.log(`Fetching emojis for guild ${CONFIG.guildId}...`);
  const emojis = await getGuildEmojis(CONFIG.guildId);
  const filteredEmojis = limitItems(filterEmojis(emojis), CONFIG.maxEmojis);
  console.log(`Fetched ${emojis.length} emoji(s); auditing ${filteredEmojis.length} after filters.`);

  const startedAt = Date.now();
  const rows = await mapConcurrent(filteredEmojis, CONFIG.concurrency, async (emoji, index) => {
    const row = await auditEmoji(emoji);
    const processed = index + 1;
    console.log(
      `[${processed}/${filteredEmojis.length}] ${emoji.name} -> total=${row.total_results} lastUsed=${row.last_used_at || 'never'}`,
    );
    return row;
  });

  const sortedRows = sortRows(rows);

  await mkdir(CONFIG.outputDir, { recursive: true });
  const csvPath = `${CONFIG.outputDir}/${CONFIG.outputCsvName}`;
  const jsonPath = `${CONFIG.outputDir}/${CONFIG.outputJsonName}`;

  await writeCsv(sortedRows, csvPath);
  await writeJson(sortedRows, jsonPath);

  summarizeRun(sortedRows);

  const elapsedMs = Date.now() - startedAt;
  console.log('');
  console.log(`CSV written to: ${csvPath}`);
  console.log(`JSON written to: ${jsonPath}`);
  console.log(`Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);
}

main().catch((error) => {
  console.error('Fatal error');
  console.error(error);
  process.exitCode = 1;
});
