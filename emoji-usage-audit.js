#!/usr/bin/env node
import dotenv from 'dotenv';
import { REST, RESTEvents } from '@discordjs/rest';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';

dotenv.config();

const CLI_VERSION = '1.0.0';
const DEFAULT_CONFIG_FILENAME = 'emoji-audit.yml';

const DEFAULT_CONFIG = {
  guildId: '',
  search: {
    maxEmojis: null,
    after: null,
    before: null,
    animated: null,
    available: null,
    managed: null,
    onlyEmojiNames: [],
    skipEmojiNames: [],
  },
  output: {
    dir: './output',
    excerptLength: 30,
  },
  runtime: {
    concurrency: 2,
    apiVersion: '9',
    maxRequestRetries: 6,
    retryBaseMs: 750,
    indexRetryCapMs: 15_000,
    logRateLimits: true,
  },
};

const HELP_TEXT = `Discord Emoji Usage Audit

Usage:
  emoji-audit [options]
  node emoji-usage-audit.js [options]

Default config:
  The CLI will try to read ./${DEFAULT_CONFIG_FILENAME} (default path)
  If that default file does not exist, execution continues without error.

Environment:
  DISCORD_BOT_TOKEN          Required bot token

Options:
  --config <path>            Load a specific YAML config file (default: ./${DEFAULT_CONFIG_FILENAME})
  --guild-id <id>            Override guildId from config (default: config value)
  --animated <true|false>    true=animated only, false=static only (default: null)
  --available <true|false>   true=available only, false=unavailable only (default: null)
  --managed <true|false>     true=managed only, false=unmanaged only (default: null)
  --only <a,b,c>             Override search.onlyEmojiNames (default: empty)
  --skip <a,b,c>             Override search.skipEmojiNames (default: empty)
  --max-emojis <n|null>      Override search.maxEmojis (default: ${DEFAULT_CONFIG.search.maxEmojis})
  --output-dir <path>        Override output.dir (default: ${DEFAULT_CONFIG.output.dir})
  --excerpt-length <n>       Override output.excerptLength (default: ${DEFAULT_CONFIG.output.excerptLength})
  --concurrency <n>          Override runtime.concurrency (default: ${DEFAULT_CONFIG.runtime.concurrency})
  --log-rate-limits <true|false>
                             Set runtime.logRateLimits (default: ${DEFAULT_CONFIG.runtime.logRateLimits})
  Output files are always named report-yymmdd-hhmmss.csv/json.
  --help                     Show this help text
  --version                  Show CLI version
`;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (Array.isArray(override)) {
    return [...override];
  }

  if (!isPlainObject(override)) {
    return override;
  }

  const baseObject = isPlainObject(base) ? base : {};
  const result = { ...baseObject };

  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value)) {
      result[key] = [...value];
      continue;
    }

    if (isPlainObject(value)) {
      result[key] = deepMerge(baseObject[key], value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

function assignIfDefined(values, inputKey, target, pathSegments, transform = (value) => value) {
  if (values[inputKey] === undefined) {
    return;
  }

  let current = target;

  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    const segment = pathSegments[index];
    if (!isPlainObject(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }

  current[pathSegments[pathSegments.length - 1]] = transform(values[inputKey]);
}

function parseListFlag(value) {
  if (value.trim() === '') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIntegerFlag(name, value, { allowNull = false, min = 0 } = {}) {
  if (allowNull && ['null', 'none', 'all'].includes(value.toLowerCase())) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== value.trim()) {
    throw new Error(`Invalid value for ${name}: ${value}`);
  }
  if (parsed < min) {
    throw new Error(`${name} must be >= ${min}`);
  }
  return parsed;
}

function parseBooleanFlag(name, value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid value for ${name}: ${value}. Expected true or false.`);
}

function parseCliArgs(argv) {
  const overrides = {};
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean' },
      version: { type: 'boolean' },
      config: { type: 'string' },
      'guild-id': { type: 'string' },
      'output-dir': { type: 'string' },
      concurrency: { type: 'string' },
      'max-emojis': { type: 'string' },
      only: { type: 'string' },
      skip: { type: 'string' },
      animated: { type: 'string' },
      available: { type: 'string' },
      managed: { type: 'string' },
      'excerpt-length': { type: 'string' },
      'log-rate-limits': { type: 'string' },
    },
  });

  if (positionals.length > 0) {
    throw new Error(`Unknown positional argument: ${positionals[0]}`);
  }

  assignIfDefined(values, 'guild-id', overrides, ['guildId']);
  assignIfDefined(values, 'animated', overrides, ['search', 'animated'], (value) =>
    parseBooleanFlag('--animated', value),
  );
  assignIfDefined(values, 'available', overrides, ['search', 'available'], (value) =>
    parseBooleanFlag('--available', value),
  );
  assignIfDefined(values, 'managed', overrides, ['search', 'managed'], (value) =>
    parseBooleanFlag('--managed', value),
  );
  assignIfDefined(values, 'only', overrides, ['search', 'onlyEmojiNames'], parseListFlag);
  assignIfDefined(values, 'skip', overrides, ['search', 'skipEmojiNames'], parseListFlag);
  assignIfDefined(values, 'max-emojis', overrides, ['search', 'maxEmojis'], (value) =>
    parseIntegerFlag('--max-emojis', value, { allowNull: true, min: 0 }),
  );
  assignIfDefined(values, 'output-dir', overrides, ['output', 'dir']);
  assignIfDefined(values, 'excerpt-length', overrides, ['output', 'excerptLength'], (value) =>
    parseIntegerFlag('--excerpt-length', value, { min: 0 }),
  );
  assignIfDefined(values, 'concurrency', overrides, ['runtime', 'concurrency'], (value) =>
    parseIntegerFlag('--concurrency', value, { min: 1 }),
  );
  assignIfDefined(values, 'log-rate-limits', overrides, ['runtime', 'logRateLimits'], (value) =>
    parseBooleanFlag('--log-rate-limits', value),
  );

  return {
    configPath: values.config ?? null,
    overrides,
    showHelp: values.help ?? false,
    showVersion: values.version ?? false,
  };
}

function resolveConfigPath(cliConfigPath) {
  if (cliConfigPath) {
    return {
      path: path.resolve(process.cwd(), cliConfigPath),
      explicit: true,
      source: '--config',
    };
  }

  return {
    path: path.resolve(process.cwd(), DEFAULT_CONFIG_FILENAME),
    explicit: false,
    source: 'default',
  };
}

async function loadConfigFile(configLocation) {
  try {
    await access(configLocation.path, fsConstants.F_OK);
  } catch {
    if (configLocation.explicit) {
      throw new Error(`Config file not found: ${configLocation.path}`);
    }
    return {};
  }

  const text = await readFile(configLocation.path, 'utf8');

  let parsed;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new Error(`Failed to parse config file ${configLocation.path}: ${error.message}`);
  }

  if (parsed === null || parsed === undefined) {
    return {};
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Config file ${configLocation.path} must contain a top-level mapping`);
  }

  return parsed;
}

function normalizeOptionalString(value, fieldName) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  return value.trim();
}

function normalizeString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeBooleanOrNull(value, fieldName) {
  if (value === null) return null;
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be true, false, or null`);
  }
  return value;
}

function normalizeIntegerOrNull(value, fieldName, { min = 0, allowNull = true } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new Error(`${fieldName} is required`);
  }

  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${fieldName} must be an integer >= ${min}`);
  }

  return value;
}

function normalizeInteger(value, fieldName, { min = 0 } = {}) {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${fieldName} must be an integer >= ${min}`);
  }
  return value;
}

function normalizeStringArray(value, fieldName) {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings or null`);
  }

  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`${fieldName}[${index}] must be a string`);
    }
    return item.trim();
  });
}

function dateToSnowflake(date, fieldName) {
  const discordEpoch = 1_420_070_400_000n;
  const ms = BigInt(date.getTime());

  if (ms < discordEpoch) {
    throw new Error(`${fieldName} must be on or after 2015-01-01T00:00:00.000Z`);
  }

  return ((ms - discordEpoch) << 22n).toString();
}

function normalizeSnowflakeOrDate(value, fieldName) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();

    if (trimmed === '') {
      return null;
    }

    if (/^\d+$/.test(trimmed)) {
      return trimmed;
    }

    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return dateToSnowflake(parsed, fieldName);
    }
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`${fieldName} must be a valid snowflake or Date-compatible value`);
    }
    return dateToSnowflake(value, fieldName);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return dateToSnowflake(new Date(value), fieldName);
  }

  throw new Error(`${fieldName} must be a snowflake or Date-compatible value`);
}

function buildRuntimeConfig(mergedConfig, envConfig) {
  const searchAfter = normalizeSnowflakeOrDate(mergedConfig.search.after, 'search.after');
  const searchBefore = normalizeSnowflakeOrDate(mergedConfig.search.before, 'search.before');

  if (searchAfter && searchBefore && BigInt(searchAfter) > BigInt(searchBefore)) {
    throw new Error('search.after must be <= search.before');
  }

  return {
    token: normalizeOptionalString(envConfig.token, 'DISCORD_BOT_TOKEN'),
    guildId: normalizeOptionalString(mergedConfig.guildId, 'guildId'),
    apiVersion: normalizeString(mergedConfig.runtime.apiVersion, 'runtime.apiVersion'),
    concurrency: normalizeInteger(mergedConfig.runtime.concurrency, 'runtime.concurrency', { min: 1 }),
    maxRequestRetries: normalizeInteger(mergedConfig.runtime.maxRequestRetries, 'runtime.maxRequestRetries', { min: 0 }),
    retryBaseMs: normalizeInteger(mergedConfig.runtime.retryBaseMs, 'runtime.retryBaseMs', { min: 0 }),
    indexRetryCapMs: normalizeInteger(mergedConfig.runtime.indexRetryCapMs, 'runtime.indexRetryCapMs', { min: 0 }),
    logRateLimits: normalizeBooleanOrNull(mergedConfig.runtime.logRateLimits, 'runtime.logRateLimits') ?? true,
    filterAnimated: normalizeBooleanOrNull(mergedConfig.search.animated, 'search.animated'),
    filterAvailable: normalizeBooleanOrNull(mergedConfig.search.available, 'search.available'),
    filterManaged: normalizeBooleanOrNull(mergedConfig.search.managed, 'search.managed'),
    onlyEmojiNames: normalizeStringArray(mergedConfig.search.onlyEmojiNames, 'search.onlyEmojiNames'),
    skipEmojiNames: normalizeStringArray(mergedConfig.search.skipEmojiNames, 'search.skipEmojiNames') ?? [],
    searchMaxEmojis: normalizeIntegerOrNull(mergedConfig.search.maxEmojis, 'search.maxEmojis', { min: 0, allowNull: true }),
    searchAfter,
    searchBefore,
    outputDir: normalizeString(mergedConfig.output.dir, 'output.dir'),
    excerptLength: normalizeInteger(mergedConfig.output.excerptLength, 'output.excerptLength', { min: 0 }),
  };
}

async function loadRuntimeConfig(argv) {
  const cli = parseCliArgs(argv);

  if (cli.showHelp) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (cli.showVersion) {
    console.log(CLI_VERSION);
    process.exit(0);
  }

  const envConfig = {
    token: process.env.DISCORD_BOT_TOKEN ?? '',
  };

  const configLocation = resolveConfigPath(cli.configPath);
  const fileConfig = await loadConfigFile(configLocation);
  const mergedConfig = deepMerge(deepMerge(DEFAULT_CONFIG, fileConfig), cli.overrides);

  return buildRuntimeConfig(mergedConfig, envConfig);
}

function createRestClient(config) {
  const client = new REST({ version: config.apiVersion }).setToken(config.token);

  client.on(RESTEvents.RateLimited, (info) => {
    if (!config.logRateLimits) return;
    console.warn(
      `[rate-limit] scope=${info.scope} global=${info.global} method=${info.method} route=${info.route} retryAfterMs=${info.retryAfter}`,
    );
  });

  return client;
}

function assertConfig(config) {
  if (!config.token) {
    throw new Error('Missing required bot token. Set DISCORD_BOT_TOKEN in the environment.');
  }

  if (!config.guildId) {
    throw new Error(`Missing guildId. Set it in ${DEFAULT_CONFIG_FILENAME} or pass --guild-id.`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function excerpt(text, maxLength) {
  if (!text) return '';
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function daysBetween(earlier, later = new Date()) {
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

function buildLatestSearchRoute(config, emoji) {
  const params = new URLSearchParams();
  params.set('content', buildEmojiSearchKeyword(emoji));
  params.set('sort_by', 'timestamp');
  params.set('sort_order', 'desc');
  params.set('offset', '0');

  if (config.searchAfter) {
    params.set('min_id', config.searchAfter);
  }

  if (config.searchBefore) {
    params.set('max_id', config.searchBefore);
  }

  return `/guilds/${config.guildId}/messages/search?${params.toString()}`;
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

function summarizeMessage(message, config) {
  if (!message) {
    return {
      timestamp: '',
      contentExcerpt: '',
      url: '',
    };
  }

  return {
    timestamp: toIso(message.timestamp),
    contentExcerpt: excerpt(message.content ?? '', config.excerptLength),
    url: buildMessageUrl(config.guildId, message.channel_id, message.id),
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

function filterEmojis(emojis, config) {
  const onlySet = Array.isArray(config.onlyEmojiNames) && config.onlyEmojiNames.length > 0
    ? new Set(config.onlyEmojiNames)
    : null;
  const skipSet = new Set(config.skipEmojiNames ?? []);

  return emojis.filter((emoji) => {
    if (config.filterAnimated !== null && Boolean(emoji.animated) !== config.filterAnimated) return false;
    if (config.filterAvailable !== null && Boolean(emoji.available) !== config.filterAvailable) return false;
    if (config.filterManaged !== null && Boolean(emoji.managed) !== config.filterManaged) return false;
    if (onlySet && !onlySet.has(emoji.name)) return false;
    if (skipSet.has(emoji.name)) return false;
    return true;
  });
}

async function apiGet(rest, config, route) {
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
          config.indexRetryCapMs,
        );
        console.warn(`[indexing] ${route} not ready yet; retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      return result;
    } catch (error) {
      const normalized = normalizeDiscordError(error);
      const status = Number(normalized?.status ?? 0);
      const retriable = [500, 502, 503, 504].includes(status)
        || /ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(error?.message ?? ''));

      if (!retriable || attempt >= config.maxRequestRetries) {
        throw error;
      }

      const waitMs = config.retryBaseMs * (2 ** attempt) + Math.floor(Math.random() * 250);
      console.warn(`[retry] ${route} failed with status=${status || 'unknown'}; retrying in ${waitMs}ms`);
      attempt += 1;
      await sleep(waitMs);
    }
  }
}

async function getGuildEmojis(rest, config, guildId) {
  const route = `/guilds/${guildId}/emojis`;
  const result = await apiGet(rest, config, route);
  if (!Array.isArray(result)) {
    throw new Error(`Unexpected emoji response shape from ${route}`);
  }
  return result;
}

async function auditEmoji(rest, config, emoji) {
  const createdAt = snowflakeToDate(emoji.id);
  const latestResponse = await apiGet(rest, config, buildLatestSearchRoute(config, emoji));
  const latestMessage = findLatestMatchingMessage(latestResponse.messages, emoji);
  const totalResults = latestMessage && Number.isFinite(Number(latestResponse.total_results))
    ? Number(latestResponse.total_results)
    : 0;
  const latest = summarizeMessage(latestMessage, config);
  const lastUseDate = latest.timestamp || '';
  const emojiAgeDays = daysBetween(createdAt);
  const lastUseAgeDays = daysBetween(lastUseDate);
  const usesPer30dSinceCreation = emojiAgeDays && emojiAgeDays > 0
    ? Number(((totalResults / emojiAgeDays) * 30).toFixed(3))
    : 0;

  return {
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

function pad2(value) {
  return String(value).padStart(2, '0');
}

function buildReportBasename(date = new Date()) {
  const year = String(date.getFullYear()).slice(-2);
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  const second = pad2(date.getSeconds());
  return `report-${year}${month}${day}-${hour}${minute}${second}`;
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
  const config = await loadRuntimeConfig(process.argv.slice(2));
  assertConfig(config);
  const rest = createRestClient(config);

  console.log(`Fetching emojis for guild ${config.guildId}...`);
  const emojis = await getGuildEmojis(rest, config, config.guildId);
  const filteredEmojis = limitItems(filterEmojis(emojis, config), config.searchMaxEmojis);
  console.log(`Fetched ${emojis.length} emoji(s); auditing ${filteredEmojis.length} after search criteria.`);

  const startedAt = Date.now();
  let completed = 0;
  const rows = await mapConcurrent(filteredEmojis, config.concurrency, async (emoji) => {
    const row = await auditEmoji(rest, config, emoji);
    completed += 1;
    console.log(
      `[${completed}/${filteredEmojis.length}] ${emoji.name} -> total=${row.total_results} lastUsed=${row.last_used_at || 'never'}`,
    );
    return row;
  });

  const sortedRows = sortRows(rows);
  await mkdir(config.outputDir, { recursive: true });
  const reportBasename = buildReportBasename();
  const csvPath = path.join(config.outputDir, `${reportBasename}.csv`);
  const jsonPath = path.join(config.outputDir, `${reportBasename}.json`);

  await writeCsv(sortedRows, csvPath);
  await writeJson(sortedRows, jsonPath);
  summarizeRun(sortedRows);

  console.log('');
  console.log(`CSV written to: ${csvPath}`);
  console.log(`JSON written to: ${jsonPath}`);
  console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((error) => {
  console.error('Fatal error');
  console.error(error.message ?? error);
  process.exitCode = 1;
});
